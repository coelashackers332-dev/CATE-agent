// The tools the voice model can call (CONTRACTS.md §3). The model talks; every rule is enforced here.
//
// createTools(deps) → { specs, runTool }
//   deps.cathay   : either a FACTORY (callId) => adapter, e.g. (callId) => createCathay({ callId }), so the projector
//                   lines carry the call id (preferred); or one adapter instance (its lines then carry its own callId).
//   deps.messages : { sendSms(to, body), sendEmail(to, subject, html, text) }
//   deps.texts    : { optionsSms(options, link), payRequestSms(order, travellerName) }
//   deps.emails   : (not used by the tools any more: the member pays himself on his trip page)
//   deps.baseUrl  : public address used in trip-page links (default config.baseUrl)
//   deps.knowledge: { search(question, limit) → Promise<[{ title, text, source, checked }]> }, [] when nothing is relevant.
//                   Optional: without it ask_cathay always answers "I do not have that information".
//
// Besides the fields in CONTRACTS §2, tools keep on the call object (server side, never sent to the model as such):
//   call.profile (model-safe profile + recent trips), call.order (the hold), call.verifyFails, call.payRequested.
import { config } from './config.js';
import { emit } from './events.js';
import { store, newPageCode } from './store.js';
import { fmtDay } from './screens/trip.js';

const MAX_VERIFY_TRIES = 3;
const MAX_PASSAGES = 3;   // how many knowledge passages ask_cathay hands the model

// ---- Cities we fly: every airport in data/flights.json (the OAG schedule). Anything else gets "no flights", never a guess.
// Where a city has two airports, the city name means the main one (Tokyo = Narita, Shanghai = Pudong).
const CITIES = {
  HKG: 'Hong Kong', YVR: 'Vancouver', KIX: 'Osaka', NRT: 'Tokyo', HND: 'Tokyo Haneda', NGO: 'Nagoya', FUK: 'Fukuoka',
  CTS: 'Sapporo', ICN: 'Seoul', TPE: 'Taipei', KHH: 'Kaohsiung', PEK: 'Beijing', PVG: 'Shanghai', SHA: 'Shanghai Hongqiao',
  CAN: 'Guangzhou', HGH: 'Hangzhou', CTU: 'Chengdu', CKG: 'Chongqing', WUH: 'Wuhan', WNZ: 'Wenzhou', FOC: 'Fuzhou',
  XMN: 'Xiamen', CSX: 'Changsha', TAO: 'Qingdao', NKG: 'Nanjing', XIY: "Xi'an", NGB: 'Ningbo', CGO: 'Zhengzhou',
  HAK: 'Haikou', URC: 'Urumqi', MNL: 'Manila', CEB: 'Cebu', SGN: 'Ho Chi Minh City', HAN: 'Hanoi', BKK: 'Bangkok',
  HKT: 'Phuket', KUL: 'Kuala Lumpur', PEN: 'Penang', SIN: 'Singapore', CGK: 'Jakarta', SUB: 'Surabaya', DPS: 'Bali',
  KTI: 'Phnom Penh', DEL: 'Delhi', BOM: 'Mumbai', BLR: 'Bengaluru', MAA: 'Chennai', HYD: 'Hyderabad', KTM: 'Kathmandu',
  DAC: 'Dhaka', CMB: 'Colombo', SYD: 'Sydney', MEL: 'Melbourne', BNE: 'Brisbane', PER: 'Perth', ADL: 'Adelaide',
  AKL: 'Auckland', CHC: 'Christchurch', LHR: 'London', MAN: 'Manchester', CDG: 'Paris', FRA: 'Frankfurt', MUC: 'Munich',
  ZRH: 'Zurich', AMS: 'Amsterdam', BRU: 'Brussels', MXP: 'Milan', MAD: 'Madrid', JNB: 'Johannesburg',
  JFK: 'New York', BOS: 'Boston', ORD: 'Chicago', DFW: 'Dallas', LAX: 'Los Angeles', SFO: 'San Francisco',
  SEA: 'Seattle', YYZ: 'Toronto',
};
// Other names people say for the same airports.
const ALIASES = {
  haneda: 'HND', narita: 'NRT', hongqiao: 'SHA', pudong: 'PVG', bangalore: 'BLR', saigon: 'SGN', xian: 'XIY',
  denpasar: 'DPS', 'new york city': 'JFK', 'new delhi': 'DEL', bombay: 'BOM', madras: 'MAA',
};
const cityOf = (code) => CITIES[code] ?? code;
const codeOf = (said) => {
  const s = String(said ?? '').trim().toLowerCase();
  return Object.keys(CITIES).find((code) => code.toLowerCase() === s || CITIES[code].toLowerCase() === s) ?? ALIASES[s] ?? null;
};
const MAX_DAYS_NAMED = 5;   // "what days do you fly?": at most this many days are read out, from his date (or today) on

// ---- Wheelchair rule table (IATA special service request codes). Asked in this order; the first "no" sets the code.
const RULES = [
  { key: 'walk_in_cabin', ifNo: 'WCHC', question: 'Can you walk to your seat inside the plane on your own?' },
  { key: 'stairs', ifNo: 'WCHS', question: 'Can you go up and down stairs?' },
  { key: 'long_distance', ifNo: 'WCHR', question: 'Can you walk long distances, like from check-in to the gate?' },
];
const ASSISTANCE = {
  WCHC: 'Wheelchair all the way to the seat on the plane.',
  WCHS: 'Wheelchair from check-in to the aircraft door, with help on stairs. Can walk to the seat on the plane.',
  WCHR: 'Wheelchair from check-in to the gate. Can manage stairs and walk to the seat.',
};
const NO_ASSISTANCE = 'No wheelchair needed.';
const wheelchairCode = (ssr) => ssr?.find((code) => code in ASSISTANCE) ?? null;

// ---- Who gets CATE: Gold and above (GAME-PLAN 2026-11-15 §7). A member with a registered assistance need gets CATE
// at every tier (open point 1, proposed), so the accessibility feature is never behind a status wall.
const TIERS_WITH_CATE = ['Gold', 'Diamond', 'Diamond Exec', 'Diamond Plus'];

// ---- Booking details a member can choose (the mock Orders system accepts the same lists).
const SEATS = ['window', 'aisle'];
const SEAT_AREAS = ['front', 'middle', 'back'];
const MEALS = ['standard', 'vegetarian', 'vegan', 'halal', 'kosher', 'hindu', 'diabetic', 'low salt', 'gluten free', 'child'];
const SEAT_NUMBER = /^([1-9]|[1-6]\d|70)[ABCDEFGHJK]$/;
const MAX_EXTRA_BAGS = 3;
const MAX_REQUESTS = 3;
const NO_REQUEST = 'No special requests.';

// ---- Small helpers
const fail = (error) => ({ ok: false, error });
const yesNo = (v) => (v === true || v === 'yes' || v === 'true' ? true : v === false || v === 'no' || v === 'false' ? false : null);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && !Number.isNaN(Date.parse(s));
const timeOf = (dateTime) => dateTime.slice(11, 16);
/** "11:40 am", "11:50 pm": clearer when spoken than a 24-hour time. */
const spokenTime = (dateTime) => {
  const [h, m] = timeOf(dateTime).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
const spokenMoney = (hkd) => `${Number(hkd).toLocaleString('en-US')} Hong Kong dollars`;
/** "WONG TAK MING" → "Wong Tak Ming", for speech and messages. The ticket name stays as on file. */
const titleCase = (name) => name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
/** Flight time by the local clocks. Only used to compare flights on the same route, where the time zones cancel out. */
const clockHours = (f) => (Date.parse(`${f.arr}Z`) - Date.parse(`${f.dep}Z`)) / 36e5;
const nonstopFirst = (a, b) => a.stops.length - b.stops.length;
/** "https://www.cathaypacific.com/baggage.html?x=1" → "cathaypacific.com/baggage.html": short enough for one projector line. */
const shortSource = (source) => String(source).replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '');
const segment = (f) => ({ flight: f.flight, from: f.from, to: f.to, city: cityOf(f.to), dep: f.dep, arr: f.arr, stops: f.stops });

const specs = [
  {
    name: 'verify_caller',
    description: 'Call first, as soon as the caller has answered "Where did you last fly with us?". Pass the answer in his own words. '
      + 'The phone number comes from the phone network, never from speech. If verified is false, ask the question once more and say nothing about his account.',
    inputSchema: {
      type: 'object',
      properties: { answer: { type: 'string', description: 'What the caller said, e.g. "Osaka, last May"' } },
      required: ['answer'],
    },
  },
  {
    name: 'apply_profile',
    description: 'Call right after verify_caller passes. Returns his name, seat and meal preferences, needs and recent trips. '
      + 'Greet him by name and do not ask for anything that is already on file.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'find_flights',
    description: 'Call when you know the destination city and the dates. Returns at most 3 options from the Cathay schedule, already matched to his profile. '
      + 'Read out read_out and return_flight slowly, one option at a time, and say left_out if it is there. Never say a flight, time or price that is not in the result.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination city as the caller said it, e.g. "Vancouver"' },
        after: { type: 'string', description: 'Leave after this date, YYYY-MM-DD' },
        before: { type: 'string', description: 'Be back before this date, YYYY-MM-DD' },
        from: { type: 'string', description: 'Departure city. Leave out for Hong Kong.' },
      },
      required: ['to', 'after', 'before'],
    },
  },
  {
    name: 'text_options',
    description: 'Sends the options from find_flights and the link to his trip page to the contact on his membership (text or email). '
      + 'Call after he says yes to "Shall I text these to you?", or when he asks for them to be sent (again). '
      + 'It takes no input: you cannot send to any other number or address. Then say what the result tells you.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'choose_option',
    description: 'Call as soon as he says which flight option he wants. Records his choice. The result gives you a sentence to say back to him and the next question to ask. '
      + 'Never call it with an option he has not chosen.',
    inputSchema: {
      type: 'object',
      properties: { option_id: { type: 'string', description: 'The id of the option he chose, from find_flights' } },
      required: ['option_id'],
    },
  },
  {
    name: 'set_preferences',
    description: 'Call as soon as he answers the question about the seat and meal on his membership. Records his answer. '
      + 'If he wants a different seat, pass what he asked for: window or aisle, front, middle or back of the cabin, or a seat number like 21A. '
      + 'If he wants a different meal, pass it. The result gives you a sentence to say back to him and the next question to ask.',
    inputSchema: {
      type: 'object',
      properties: {
        seat_ok: { type: 'boolean', description: 'True if the seat on his membership is still right; false if he wants a different seat' },
        meal_ok: { type: 'boolean', description: 'True if the meal on his membership is still right; false if he wants a different meal' },
        seat: { type: 'string', enum: SEATS, description: 'Only if he wants a different seat: window or aisle' },
        seat_area: { type: 'string', enum: SEAT_AREAS, description: 'Only if he named one: front, middle or back of the cabin' },
        seat_number: { type: 'string', description: 'Only if he named a seat, e.g. "21A"' },
        meal: { type: 'string', enum: MEALS, description: 'Only if he wants a different meal' },
      },
      required: ['seat_ok', 'meal_ok'],
    },
  },
  {
    name: 'set_baggage',
    description: 'Call as soon as he answers whether he wants extra checked baggage on top of the bags on his membership. '
      + 'Pass 0 for no extra bags. The result gives you a sentence to say back to him and the next question to ask.',
    inputSchema: {
      type: 'object',
      properties: { extra_bags: { type: 'integer', minimum: 0, maximum: MAX_EXTRA_BAGS, description: 'Extra checked bags he wants, 0 to 3' } },
      required: ['extra_bags'],
    },
  },
  {
    name: 'set_special_request',
    description: 'Call when he answers "Is there anything else we should arrange for this trip?", or whenever he asks for something special '
      + '(a birthday or anniversary on board, medical equipment, help with a connection). Pass his request in his own words, or none true. '
      + 'It is recorded on the booking for Cathay staff; never promise that it will be granted.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'His request in his own words, e.g. "It is my wife\'s birthday on the flight"' },
        none: { type: 'boolean', description: 'True if he has no special request' },
      },
    },
  },
  {
    name: 'set_assistance',
    description: 'Call to set wheelchair help before holding the booking. If a recent trip has assistance on file, ask "Same as last time?" and on yes pass same_as_last_trip true. '
      + 'Otherwise ask the three questions in order and pass his answers; stop at the first "no". Never say the code. The result gives you a sentence to say back to him and the next question to ask.',
    inputSchema: {
      type: 'object',
      properties: {
        same_as_last_trip: { type: 'boolean', description: 'True if he wants the same help as on his last flight' },
        walk_in_cabin: { type: 'boolean', description: RULES[0].question },
        stairs: { type: 'boolean', description: RULES[1].question },
        long_distance: { type: 'boolean', description: RULES[2].question },
      },
    },
  },
  {
    name: 'hold_booking',
    description: 'Call for the read-back once his option, seat and meal, and wheelchair help are all recorded; if one is missing it tells you what to ask. '
      + 'The first call returns a readback: say it to him word for word and wait. '
      + 'Only after he clearly says yes to that question, call again with caller_confirmed true; a reply about anything else is not a yes. Then tell him the booking reference, letter by letter.',
    inputSchema: {
      type: 'object',
      properties: {
        caller_confirmed: { type: 'boolean', description: 'True only if his last words were a clear yes to the readback question' },
        option_id: { type: 'string', description: 'Only if he changes his option now: the id of the new option' },
      },
    },
  },
  {
    name: 'send_pay_link',
    description: 'Call right after the booking is held, unless the hold_booking result says the payment page is already open. The member pays himself: the payment page opens on his phone (or the pay request goes to '
      + 'his own phone), never to anyone else. It takes no input. Say what the result tells you. You will be told when the payment arrives.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'find_booking',
    description: 'Call when he wants to change a booking he already has (dates, seat, meal or baggage). Returns his bookings that can still be changed. '
      + 'If there are several, ask which one. Never read out a booking that is not in the result.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'change_booking',
    description: 'Changes one of his bookings from find_booking. For new dates, first call find_flights to the same city and let him choose, then pass option_id. '
      + 'For a seat, meal or baggage change, pass only what he wants changed. The first call returns a readback: say it word for word and wait. '
      + 'Only after he clearly says yes, call again with the same changes and caller_confirmed true.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The booking reference from find_booking' },
        option_id: { type: 'string', description: 'Only for new dates: the option he chose from find_flights' },
        seat: { type: 'string', enum: SEATS },
        seat_area: { type: 'string', enum: SEAT_AREAS },
        seat_number: { type: 'string', description: 'e.g. "21A"' },
        meal: { type: 'string', enum: MEALS },
        extra_bags: { type: 'integer', minimum: 0, maximum: MAX_EXTRA_BAGS, description: 'The number of extra bags he wants on this booking in total' },
        caller_confirmed: { type: 'boolean', description: 'True only if his last words were a clear yes to the change readback' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'ask_cathay',
    description: 'Call when he asks a general question about flying with Cathay that is not about this booking: baggage, check-in times, '
      + 'wheelchair help at the airport, mobility aids, medical equipment, changing a ticket. Pass his question in his own words. '
      + 'Answer only from the passages returned, in one or two short sentences, and say it is from the Cathay website. '
      + 'If found is false, say you do not have that information and offer a member of staff. Never use this for flights, prices or his booking.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'His question in his own words, e.g. "Can I bring my own wheelchair?"' } },
      required: ['question'],
    },
  },
];

export function createTools(deps) {
  const baseUrl = deps.baseUrl ?? config.baseUrl;
  const adapterFor = (call) => (typeof deps.cathay === 'function' ? deps.cathay(call.id) : deps.cathay);

  /** Profile + recent trips, read once per call, only with the token from a passed verification. */
  async function profileOf(call, cathay) {
    if (!call.profile) {
      const profile = await cathay.getProfile(call.token);
      const trips = await cathay.getTripHistory(call.token);
      // `assistance` gives the model plain words to say instead of the code.
      call.profile = { ...profile, recent_trips: trips.map((t) => ({ ...t, assistance: ASSISTANCE[wheelchairCode(t.ssr)] ?? NO_ASSISTANCE })) };
    }
    return call.profile;
  }

  /** Creates or refreshes this call's one view-only trip page and returns its link. Only a call creates pages. */
  function tripPage(call) {
    call.pageCode ??= newPageCode();
    // A booking changed without new flights has no options on this call: the page lasts until that trip is over.
    const trips = call.options?.length ? call.options : [call.order].filter(Boolean);
    const lastArrival = trips.map((o) => o.back.arr.slice(0, 10)).sort().at(-1);
    const expires = new Date(Date.parse(lastArrival) + 864e5).toISOString().slice(0, 10);   // the day after the trip
    store.pages.set(call.pageCode, { member_id: call.memberId, options: call.options, ref: call.ref ?? null, expires });
    return `${baseUrl}/v/${call.pageCode}`;
  }

  /** PAYMENT=page: his open trip page goes to the pay page by itself while the booking is held (server.js), so nothing is sent. */
  function openPayPage(call) {
    emit(call.id, 'screen', { what: 'pay_page', summary: 'payment page opens on his phone' });
    call.payRequested = 'his trip page';
  }

  /** Sends this call's options and trip page link to the member's own number on file (by email when TEXTS=email). */
  async function sendOptions(call) {
    const link = tripPage(call);
    await deps.messages.sendSms(call.callerId, deps.texts.optionsSms(call.options, link));
    emit(call.id, 'screen', { what: 'sms', summary: `text 1 to the caller: ${call.options.length} options + trip link` });
    emit(call.id, 'screen', { what: 'options_page', summary: 'trip page created', url: link });
  }

  /** Illustrative fees from the Orders system, read once per call. */
  async function feesOf(call, cathay) {
    call.fees ??= await cathay.getFees().catch(() => ({ extra_bag_hkd: null }));
    return call.fees;
  }

  /** The seat as it will be booked: what he chose on this call over what is on his membership. */
  const seatOf = (profile, choice = {}) => ({
    seat: choice.seat ?? profile.prefs?.seat, seat_area: choice.seat_area ?? profile.prefs?.seat_area, seat_number: choice.seat_number ?? null,
  });
  /** "seat 21A", "a window seat near the front", "an aisle seat": the words for a seat choice. */
  function seatWords({ seat, seat_area: area, seat_number: number }) {
    if (number) return `seat ${number}`;
    if (!seat && !area) return '';
    const where = area ? ` ${area === 'middle' ? 'in the middle' : `near the ${area}`} of the cabin` : '';
    return `${seat === 'aisle' ? 'an aisle' : seat ? 'a window' : 'a'} seat${where}`;
  }
  const bagWords = (n) => `${n} extra checked bag${n === 1 ? '' : 's'}`;
  const extrasOf = (call) => (call.extraBags ?? 0) * (call.fees?.extra_bag_hkd ?? 0);

  function readback(option, profile, call) {
    const { out, back } = option;
    const seat = seatWords(seatOf(profile, call.seatChoice));
    const meal = call.meal ?? profile.prefs?.meal;
    const wishes = [seat, meal && `${/^[aeiou]/.test(meal) ? 'an' : 'a'} ${meal} meal`].filter(Boolean).join(', ');
    const extras = extrasOf(call);
    return [
      // The opening line is part of the read-back, so it is said once, at the right moment.
      `Let me read it all back to you. Nothing is booked until you say yes. Booking for ${titleCase(profile.name)}${profile.passport_on_file ? ', with the passport on your membership' : ''}.`,
      `${cityOf(out.from)} to ${out.city}, flight ${out.flight}, ${fmtDay(out.dep)}, leaving at ${spokenTime(out.dep)}${option.note ? `, ${option.note}` : ''}.`,
      `Coming back on flight ${back.flight}, ${fmtDay(back.dep)}, leaving at ${spokenTime(back.dep)}.`,
      wishes && `${wishes[0].toUpperCase()}${wishes.slice(1)}.`,
      call.assistance.summary,
      call.extraBags ? `${bagWords(call.extraBags)[0].toUpperCase()}${bagWords(call.extraBags).slice(1)}, ${spokenMoney(extras)}.` : '',
      call.requests?.length ? `Noted for our staff: ${call.requests.join('; ')}.` : '',
      `The total is ${spokenMoney(option.fare_hkd + extras)} for the return trip.`,
      config.payment === 'page' ? 'Once it is held, the payment page opens on your phone.' : 'The pay request will come to your own phone.',
      'Shall I hold this booking?',
    ].filter(Boolean).join(' ');
  }

  const ORDINAL = ['first', 'second', 'third'];
  const wishesOf = (profile) => [seatWords(seatOf(profile)), profile.prefs?.meal && `a ${profile.prefs.meal} meal`].filter(Boolean).join(' and ');

  /** What must be answered before the read-back, one question at a time, with the caller's own data in it. null = all done. */
  async function requiredStep(call, cathay) {
    const profile = await profileOf(call, cathay);
    if (!call.choice) return 'Ask which option he would like, then call choose_option.';
    if (!call.prefs && wishesOf(profile)) return `Ask: "Your membership has ${wishesOf(profile)}. Is that still right?" Then call set_preferences with his answer.`;
    if (!call.assistance) {
      const last = profile.recent_trips.find((t) => t.status === 'flown' && wheelchairCode(t.ssr));
      return last
        ? `Ask: "On your ${last.to} trip we arranged this: ${last.assistance} Would you like the same help again?" On a yes call set_assistance with same_as_last_trip true; otherwise ask its three wheelchair questions, one at a time.`
        : 'Ask the three wheelchair questions of set_assistance, one at a time, then call it.';
    }
    return null;
  }

  /** The next question: the required ones, then baggage and special requests (asked once, but not needed to hold). */
  async function nextStep(call, cathay) {
    const required = await requiredStep(call, cathay);
    if (required) return required;
    const profile = await profileOf(call, cathay);
    if (call.extraBags === undefined) {
      const fee = (await feesOf(call, cathay)).extra_bag_hkd;
      const usual = profile.prefs?.bags;
      return `Ask: "${usual ? `Your membership has ${usual} checked bag${usual === 1 ? '' : 's'}. ` : ''}Would you like any extra baggage${fee ? `? It is ${spokenMoney(fee)} a bag` : ''}?" Then call set_baggage.`;
    }
    if (call.requests === undefined) return 'Ask: "Is there anything else we should arrange for this trip, like a special occasion?" Then call set_special_request.';
    return null;
  }

  /** An answer was recorded: the model says `confirm` back at once, then asks the one next thing. Any earlier read-back is out of date. */
  async function recorded(call, cathay, confirm, extra = {}) {
    call.pendingHold = null;
    if (call.changeRef) return { ok: true, ...extra, confirm, next: `Say: "${confirm}" Then call change_booking for booking ${call.changeRef} with this change.` };
    const then = (await nextStep(call, cathay)) ?? 'call hold_booking now, in this same turn, without asking him anything first, and say the readback it returns.';
    return { ok: true, ...extra, confirm, next: `Say: "${confirm}" Then: ${then} Never record an answer he has not given.` };
  }

  /** A seat or meal he asked for, checked against the lists. → { seat, seat_area, seat_number, meal } or { error }. */
  function wishFrom(args) {
    const wish = {};
    if (args.seat != null) { if (!SEATS.includes(args.seat)) return { error: 'Ask: window or aisle?' }; wish.seat = args.seat; }
    if (args.seat_area != null) { if (!SEAT_AREAS.includes(args.seat_area)) return { error: 'Ask: front, middle or back of the cabin?' }; wish.seat_area = args.seat_area; }
    if (args.seat_number != null && args.seat_number !== '') {
      const number = String(args.seat_number).replace(/\s+/g, '').toUpperCase();
      if (!SEAT_NUMBER.test(number)) return { error: `"${args.seat_number}" is not a seat on our planes. Ask for a row from 1 to 70 and a letter, like 21A, or window or aisle.` };
      wish.seat_number = number;
    }
    if (args.meal != null) { if (!MEALS.includes(args.meal)) return { error: `Ask which meal he would like: ${MEALS.join(', ')}.` }; wish.meal = args.meal; }
    return wish;
  }

  /** Sends a short message with the trip page link to the member's own number on file (by email when TEXTS=email). */
  async function sendChangeNote(call, order) {
    const link = tripPage(call);
    const due = order.status === 'held' ? `\nPay the difference of ${Number(order.due_hkd).toLocaleString('en-US')} HKD on your trip page:` : '\nYour trip page shows the booking as it is now:';
    await deps.messages.sendSms(call.callerId, `Cathay CATE: your booking ${order.ref} has been changed${due}\n${link}`);
    emit(call.id, 'screen', { what: 'sms', summary: `booking ${order.ref} changed: trip link sent` });
  }

  const handlers = {
    // Rule: the number comes from the phone network (call.callerId); the answer is checked inside Cathay's system.
    async verify_caller({ answer }, call, cathay) {
      if (call.verified) return { ok: true, verified: true };
      if ((call.verifyFails ?? 0) >= MAX_VERIFY_TRIES) {
        return { ...fail('Too many wrong answers on this call. Say you cannot go on, and that a member of staff can help.'), verified: false };
      }
      call.memberId ??= (await cathay.findMemberByPhone(call.callerId))?.member_id ?? null;
      if (!call.memberId) return { ...fail('This phone number is not on a membership. Say you cannot go on, and that a member of staff can help.'), verified: false };
      const check = await cathay.checkVerification(call.memberId, answer);
      if (!check.ok) {
        call.verifyFails = (call.verifyFails ?? 0) + 1;
        return { ...fail('That answer does not match. Ask "Where did you last fly with us?" once more. Do not give hints.'), verified: false };
      }
      call.token = check.token;
      // Tier gate: CATE is the personal booking manager of Gold members and above, and of any member with a
      // registered assistance need. Checked in code, after verification, so nobody learns a status they cannot prove.
      const profile = await profileOf(call, cathay);
      const needsHelp = Object.values(profile.needs ?? {}).some((v) => v === false)
        || profile.recent_trips.some((t) => wheelchairCode(t.ssr));
      if (!TIERS_WITH_CATE.includes(profile.tier) && !needsHelp) {
        call.token = null;
        call.profile = null;
        call.refused = true;
        emit(call.id, 'screen', { what: 'tier', summary: `${profile.tier} member: CATE is for Gold and above` });
        return {
          ...fail('This service is for Gold members and above. Say kindly that CATE, the personal booking service, is part of Gold membership and above, '
            + 'that the Cathay app and the member service line can help with this, and that he earns Gold with his status points. Then say goodbye. '
            + 'Do not help with a booking on this call.'),
          verified: false,
        };
      }
      call.verified = true;
      emit(call.id, 'screen', { what: 'tier', summary: TIERS_WITH_CATE.includes(profile.tier) ? `${profile.tier} member` : `${profile.tier} member with an assistance need` });
      return { ok: true, verified: true, next: 'Call apply_profile now.' };
    },

    async apply_profile(_args, call, cathay) {
      const profile = await profileOf(call, cathay);
      return {
        ok: true, profile,
        next: `Thank him by family name, as a ${profile.tier} member, and ask which service he would like today: book a flight, `
          + 'change a booking he has (dates, seat, meal or baggage), or a special request. Then follow his answer.',
      };
    },

    // Rules: only seeded flights with a fare; ranked by the profile; at most 3; the model gets ready-made sentences.
    async find_flights(args, call, cathay) {
      const to = codeOf(args.to);
      const from = codeOf(args.from ?? 'HKG');
      if (!to || !from || to === from) return fail(`We have no flights for "${args.to}" here. Do not suggest any flight. Ask him which city again.`);
      // "What dates do you have?": the days we fly this route, from the schedule, so the model has something true to offer.
      // With the full OAG schedule a route flies most days, so only the first few days from his date (or today) are named.
      const daysWeFly = async () => {
        const today = new Date().toISOString().slice(0, 10);
        const start = isDate(args.after) && args.after > today ? args.after : today;
        const all = await cathay.searchFlights({ from, to, after: start, before: '2100-01-01' });
        const days = (flights) => {
          const list = [...new Set([...flights].sort((a, b) => a.dep.localeCompare(b.dep)).map((f) => fmtDay(f.dep)))];
          return list.slice(0, MAX_DAYS_NAMED).join(', ') + (list.length > MAX_DAYS_NAMED ? ' and most days after that' : '');
        };
        const out = days(all.out.filter((f) => f.return_fare_hkd != null));
        return out && all.back.length ? ` We fly to ${cityOf(to)} on ${out}, and back on ${days(all.back)}: tell him those days and ask if they would work.` : '';
      };
      if (!isDate(args.after) || !isDate(args.before) || args.before <= args.after) {
        return fail(`Two dates are needed as YYYY-MM-DD: leave after, and be back before. Ask him for the dates.${await daysWeFly()}`);
      }
      const { prefs } = await profileOf(call, cathay);
      const found = await cathay.searchFlights({ from, to, after: args.after, before: args.before });

      const earliest = prefs?.earliest_departure ?? '00:00';
      const notTooEarly = (f) => timeOf(f.dep) >= earliest;
      // Return flight, the same for every option: not too early, nonstop if there is one, then the latest.
      const back = found.back.filter(notTooEarly).sort((a, b) => nonstopFirst(a, b) || b.dep.localeCompare(a.dep))[0];
      const priced = found.out.filter((f) => f.return_fare_hkd != null).sort((a, b) => a.dep.localeCompare(b.dep));
      const fits = priced.filter(notTooEarly);
      // One option per flight number (its first date in the window), nonstop first, then by departure.
      // ponytail: no seat map in the seed data, so the seat wish is carried to the booking, not used for ranking.
      const outs = fits
        .filter((f, i) => fits.findIndex((g) => g.flight === f.flight) === i)
        .filter((f) => back && f.arr < back.dep)
        .sort((a, b) => nonstopFirst(a, b) || a.dep.localeCompare(b.dep))
        .slice(0, 3);
      if (!outs.length) return fail(`No flights fit those dates. Do not suggest any flight that is not named here.${(await daysWeFly()) || ' Ask if other dates would work.'}`);

      const fastest = Math.min(...outs.map(clockHours));
      const noteFor = (f) => {
        if (!f.stops.length) return '';
        const extra = Math.round((clockHours(f) - fastest) * 2) / 2;
        return `via ${f.stops.map(cityOf).join(' and ')}${extra > 0 ? `, ${extra} hours longer` : ''}`;
      };
      const options = outs.map((f, i) => ({ id: String(i + 1), out: segment(f), back: segment(back), fare_hkd: f.return_fare_hkd, note: noteFor(f) }));
      call.options = options;
      call.choice = null;
      call.pendingHold = null;

      const tooEarly = priced.length - fits.length;
      // PAYMENT=page: the options go to his trip page at once (the member taps one there), without a "shall I send it?"
      // question: in a real call he asked for the email twice and the model, never asked to send, told him it could not.
      // The first search sends the email; a new search only refreshes the same page.
      let sentNote = '';
      if (config.payment === 'page') {
        try {
          if (call.optionsSent) tripPage(call);
          else { await sendOptions(call); call.optionsSent = true; }
          sentNote = 'Then tell him these options are also on his trip page, in the email we just sent: he can tap the one he wants there, or tell you. ';
        } catch { /* the email failed: the spoken options are enough, and he can ask for it again (text_options) */ }
      }
      return {
        ok: true,
        options,
        // Spoken sentences, not a list: "Option 1: …, direct, …" sounded like a form being read out.
        read_out: options.map((o, i) => `The ${['first', 'second', 'third'][i]} option leaves on ${fmtDay(o.out.dep)} at ${spokenTime(o.out.dep)}. `
          + `It ${o.note ? `goes ${o.note}` : 'is direct'}, and costs ${spokenMoney(o.fare_hkd)} return.`),
        return_flight: `Every option comes back on ${fmtDay(back.dep)}, leaving at ${spokenTime(back.dep)}.`,
        ...(tooEarly > 0 && { left_out: `I left out ${tooEarly} flight${tooEarly === 1 ? ' that leaves' : 's that leave'} before ${spokenTime(`T${earliest}`.padStart(16))}, because you prefer not to leave that early.` }),
        // The model follows a hint in the result more reliably than the prompt, so the order of the next questions lives here.
        next: `${tooEarly > 0 ? 'After the return flight, say left_out. ' : ''}`
          + (sentNote ? `${sentNote}Then ask which option he would like. ` : 'Then ask "Shall I text these to you?" and after that which option he would like. ')
          + 'As soon as he chooses, call choose_option.',
      };
    },

    // Rules: only to the number on file, only this call's options. call.callerId IS the number on file:
    // the membership lookup matched it, and it never comes from speech or from the model.
    async text_options(_args, call) {
      if (!call.options?.length) return fail('There are no options to send yet. Find flights first.');
      await sendOptions(call);
      call.optionsSent = true;
      const byEmail = (process.env.TEXTS || 'email').trim().toLowerCase() === 'email';
      return {
        ok: true, sent: true,
        say: byEmail
          ? 'Tell him the email with his trip page is on its way to the email address on his membership, and that he can tap the option he wants there. Then ask which option he would like, unless he already chose.'
          : 'Tell him the text is on its way to the phone he is calling from, and that the link only shows his trip. Then ask which option he would like.',
      };
    },

    // Rule: the code comes from the fixed table or from the last flown trip on file, never from the model.
    async set_assistance(args, call, cathay) {
      let code = null;
      if (yesNo(args.same_as_last_trip)) {
        const lastFlown = (await profileOf(call, cathay)).recent_trips.find((t) => t.status === 'flown');
        code = wheelchairCode(lastFlown?.ssr);
        if (!code) return fail('No wheelchair help is on file from his last trip. Ask the three questions instead.');
      } else {
        for (const rule of RULES) {
          const answer = yesNo(args[rule.key]);
          if (answer === null) return fail(`Ask him first: "${rule.question}"`);
          if (!answer) { code = rule.ifNo; break; }
        }
      }
      call.assistance = { code, summary: code ? ASSISTANCE[code] : NO_ASSISTANCE };
      return recorded(call, cathay, call.assistance.summary, { ...call.assistance, say: 'Never say the code.' });
    },

    // The caller's own answers, one tool each: every answer is recorded, said back at once, and followed by one next question.
    async choose_option(args, call, cathay) {
      const index = call.options?.findIndex((o) => o.id === String(args.option_id)) ?? -1;
      if (index < 0) return fail('That is not one of the options from this call. Ask which option he wants.');
      const option = call.options[index];
      call.choice = option.id;
      if (call.changeRef) {
        return { ok: true, confirm: `The ${ORDINAL[index]} option.`, next: `Call change_booking now for booking ${call.changeRef} with option_id ${option.id}, and say the readback it returns.` };
      }
      return recorded(call, cathay, `The ${ORDINAL[index]} option: ${fmtDay(option.out.dep)} at ${spokenTime(option.out.dep)}, ${option.note || 'direct'}, ${spokenMoney(option.fare_hkd)} return.`);
    },

    // Rule: seat and meal come from the profile. The caller hears them and can object; a change is for staff, never invented here.
    async set_preferences(args, call, cathay) {
      // Seat and meal are separate answers: with one yes/no the model turned "another meal, same seat" into a plain yes.
      const [seatOk, mealOk] = [yesNo(args.seat_ok), yesNo(args.meal_ok)];
      if (seatOk === null || mealOk === null) return fail('Ask him first if the seat and meal on his membership are still right.');
      const wish = wishFrom(args);
      if (wish.error) return fail(wish.error);
      const wantsSeat = wish.seat || wish.seat_area || wish.seat_number;
      if (!seatOk && !wantsSeat) return fail('Ask which seat he would like: window or aisle, front, middle or back of the cabin, or a seat number like 21A. Then call set_preferences again.');
      if (!mealOk && !wish.meal) return fail(`Ask which meal he would like: ${MEALS.join(', ')}. Then call set_preferences again.`);
      const profile = await profileOf(call, cathay);
      // A seat number is a choice of its own; window/aisle and the cabin area fill in from the membership when not said.
      call.seatChoice = seatOk ? {} : wish.seat_number ? { seat_number: wish.seat_number } : { seat: wish.seat, seat_area: wish.seat_area };
      call.meal = mealOk ? undefined : wish.meal;
      call.prefs = seatOk && mealOk ? 'kept' : 'changed';
      const seat = seatWords(seatOf(profile, call.seatChoice));
      const meal = call.meal ?? profile.prefs?.meal;
      const said = [seat, meal && `${/^[aeiou]/.test(meal) ? 'an' : 'a'} ${meal} meal`].filter(Boolean).join(' and ');
      return recorded(call, cathay, `${said[0].toUpperCase()}${said.slice(1)}${call.prefs === 'kept' ? ', as on your membership' : ''}.`);
    },

    // Rule: the number of bags is a whole number 0-3; the fee comes from the Orders system, never from the model.
    async set_baggage(args, call, cathay) {
      const n = Number(args.extra_bags);
      if (!Number.isInteger(n) || n < 0 || n > MAX_EXTRA_BAGS) return fail(`Ask how many extra bags he would like, from 0 to ${MAX_EXTRA_BAGS}. More than that needs a member of staff.`);
      const fee = (await feesOf(call, cathay)).extra_bag_hkd ?? 0;
      call.extraBags = n;
      return recorded(call, cathay, n ? `${bagWords(n)[0].toUpperCase()}${bagWords(n).slice(1)}, ${spokenMoney(n * fee)}.` : 'No extra baggage.', { extra_bags: n, fee_hkd: n * fee });
    },

    // Rule: a special request is recorded for Cathay staff, in his own words, never granted or priced by CATE.
    async set_special_request(args, call, cathay) {
      const text = String(args.request ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      if (!text) {
        if (yesNo(args.none) !== true) return fail('Ask: "Is there anything else we should arrange for this trip?"');
        call.requests ??= [];
        return recorded(call, cathay, 'Nothing else to arrange.');
      }
      call.requests = [...(call.requests ?? []), text].slice(0, MAX_REQUESTS);
      emit(call.id, 'screen', { what: 'request', summary: `special request noted for staff: ${text}` });
      const medical = /oxygen|respirat|cpap|concentrator|ventilat|medical|stretcher/i.test(text);
      return recorded(call, cathay, `I have noted that for our staff: ${text}.${medical ? ' Medical equipment needs Cathay\'s approval before the flight, so I have passed it on for that check.' : ' I have passed it to our team.'}`);
    },

    // Rules: two steps (read-back, then hold); only an option from this call; name, seat and meal from the profile.
    async hold_booking(args, call, cathay) {
      if (call.ref) return { ok: true, ref: call.ref, status: 'held', already_held: true };
      if (args.option_id != null) {   // he changed his option at the read-back
        if (!call.options?.some((o) => o.id === String(args.option_id))) return fail('That is not one of the options from this call. Ask which option he wants.');
        if (call.choice !== String(args.option_id)) { call.choice = String(args.option_id); call.pendingHold = null; }
      }
      const missing = await requiredStep(call, cathay);
      if (missing) return fail(`Not yet. ${missing} Never record an answer he has not given.`);
      const option = call.options.find((o) => o.id === call.choice);
      const profile = await profileOf(call, cathay);
      if (call.extraBags) await feesOf(call, cathay);

      const confirmed = yesNo(args.caller_confirmed) === true && call.pendingHold?.option_id === option.id;
      if (!confirmed) {
        call.pendingHold = { option_id: option.id };
        return { ok: true, needs_confirmation: true, readback: readback(option, profile, call) };
      }

      // Name and passport come from the membership (the Orders system adds the passport itself); nothing is asked again.
      const seat = seatOf(profile, call.seatChoice);
      const order = await cathay.holdOrder(call.token, {
        option_id: option.id, out: option.out, back: option.back, fare_hkd: option.fare_hkd,
        cabin: 'economy', seat: seat.seat, seat_area: seat.seat_area, seat_number: seat.seat_number ?? undefined,
        meal: call.meal ?? profile.prefs?.meal, extra_bags: call.extraBags ?? 0, requests: call.requests ?? [],
        ssr: call.assistance.code ? [call.assistance.code] : [],
        payer: titleCase(profile.name),   // the member always pays for his own booking
        passenger: profile.name,
      });
      call.ref = order.ref;
      call.order = order;
      emit(call.id, 'state', { ref: order.ref, status: 'held' });   // the projector's booking status
      call.pendingHold = null;
      tripPage(call);   // the trip page now belongs to this booking (and exists even if no text was sent)
      if (config.payment === 'page') {
        // His trip page turns into the pay page by itself now (server.js), so the hold opens it: no second tool call.
        // In a real call the model said "I'll send the payment request now" and then waited 40 s without calling send_pay_link.
        openPayPage(call);
        return {
          ok: true, ref: order.ref, ref_spoken: [...order.ref].join(' '), status: 'held', sent_to: call.payRequested,
          say: 'Tell him the booking is held and read the reference letter by letter. Then tell him the payment page is now open on his phone, '
            + 'on the page from our email, and he can choose how to pay there. An email with his booking comes as soon as it is paid. Stay on the line.',
        };
      }
      return {
        ok: true, ref: order.ref, ref_spoken: [...order.ref].join(' '), status: 'held',
        say: 'Tell him the booking is held and read the reference letter by letter. Then ask if you may send the pay request now, and call send_pay_link only after he says yes.',
      };
    },

    // Rule: the member pays for himself, only through his own trip page or his own number on file. The model cannot name a recipient.
    async send_pay_link(_args, call) {
      if (!call.ref) return fail('There is no held booking yet. Hold the booking first.');
      if (call.payRequested) return { ok: true, sent_to: call.payRequested, already_sent: true };
      if (config.payment === 'page') {
        openPayPage(call);
        return {
          ok: true, sent_to: call.payRequested,
          say: 'Tell him the payment page is now open on his phone, on the page from our email, and he can choose how to pay there. An email with his booking comes as soon as it is paid. Stay on the line.',
        };
      }
      // call.callerId IS the number on file (see text_options). shortcut: no email, the model-safe profile has none; text only.
      await deps.messages.sendSms(call.callerId, deps.texts.payRequestSms(call.order, titleCase(call.order.passenger)));
      emit(call.id, 'screen', { what: 'sms', summary: 'pay request text to the caller: "Reply PAY"' });
      call.payRequested = 'his own phone';
      return {
        ok: true, sent_to: call.payRequested,
        say: 'Tell him the pay request is on its way to his own phone and that he replies PAY to that text. A text with his booking and his needs card comes as soon as it is paid. Then ask if there is anything else you can help with.',
      };
    },

    // Rule: only his own bookings, from the Orders system, and only those not flown yet.
    async find_booking(_args, call, cathay) {
      const bookings = await cathay.getBookings(call.token);
      call.bookings = bookings;
      if (!bookings.length) return { ok: true, bookings: [], say: 'Say he has no booking with us that can still be changed, and ask if he would like to book a flight.' };
      const described = bookings.map((b) => ({
        ref: b.ref, ref_spoken: [...b.ref].join(' '), status: b.status,
        trip: `${b.city}, leaving ${fmtDay(b.out.dep)} at ${spokenTime(b.out.dep)}, back ${fmtDay(b.back.dep)}`,
        seat: seatWords(b), meal: b.meal, extra_bags: b.extra_bags,
      }));
      if (bookings.length === 1) call.changeRef = bookings[0].ref;
      return {
        ok: true, bookings: described,
        say: bookings.length === 1
          ? `Tell him the booking you found: ${described[0].trip}. Ask what he would like to change: the dates, the seat, the meal or the baggage.`
          : 'Read the trips briefly and ask which booking he means, then what he would like to change.',
      };
    },

    // Rules: only his own booking; new flights only from this call's search; prices and the difference come from the
    // Orders system; two steps (read-back, then change) like a hold.
    async change_booking(args, call, cathay) {
      const ref = String(args.ref ?? '').replace(/\s+/g, '').toUpperCase();
      const booking = (call.bookings ?? await cathay.getBookings(call.token)).find((b) => b.ref === ref);
      if (!booking) return fail('That is not one of his bookings. Call find_booking and ask which booking he means.');
      call.changeRef = ref;
      const change = {};
      if (args.option_id != null) {
        const option = call.options?.find((o) => o.id === String(args.option_id));
        if (!option) return fail('That is not one of the options from this call. Call find_flights with his new dates first, then ask which option he wants.');
        if (option.out.to !== booking.out.to) return fail(`That option is not to ${booking.city}. For another city, book a new trip instead.`);
        Object.assign(change, { option_id: option.id, out: option.out, back: option.back, fare_hkd: option.fare_hkd });
      }
      const wish = wishFrom(args);
      if (wish.error) return fail(wish.error);
      if (wish.seat_number) Object.assign(change, { seat_number: wish.seat_number });
      else if (wish.seat || wish.seat_area) Object.assign(change, { ...wish.seat && { seat: wish.seat }, ...wish.seat_area && { seat_area: wish.seat_area }, seat_number: '' });
      if (wish.meal) change.meal = wish.meal;
      if (args.extra_bags != null) {
        const n = Number(args.extra_bags);
        if (!Number.isInteger(n) || n < 0 || n > MAX_EXTRA_BAGS) return fail(`Ask how many extra bags he wants on this booking in total, from 0 to ${MAX_EXTRA_BAGS}.`);
        change.extra_bags = n;
      }
      if (!Object.keys(change).length) return fail('Ask what he would like to change: the dates, the seat, the meal or the baggage.');

      // The price after the change, as the Orders system will work it out: new fare (or the old one) plus extra bags.
      const fee = (await feesOf(call, cathay)).extra_bag_hkd ?? 0;
      const fare = change.fare_hkd ?? booking.fare_hkd;
      const total = fare + (change.extra_bags ?? booking.extra_bags) * fee;
      const difference = total - booking.total_hkd;
      const key = JSON.stringify({ ref, change });
      if (!(yesNo(args.caller_confirmed) === true && call.pendingChange === key)) {
        call.pendingChange = key;
        const lines = [
          `Let me read the change back. Nothing changes until you say yes. Booking ${[...ref].join(' ')} to ${booking.city}.`,
          change.out && `New flights: leaving ${fmtDay(change.out.dep)} at ${spokenTime(change.out.dep)}, coming back ${fmtDay(change.back.dep)} at ${spokenTime(change.back.dep)}.`,
          (change.seat_number || change.seat || change.seat_area) && `Seat: ${seatWords({ seat: change.seat ?? booking.seat, seat_area: change.seat_area ?? booking.seat_area, seat_number: change.seat_number || null })}.`,
          change.meal && `Meal: ${change.meal}.`,
          change.extra_bags != null && `Baggage: ${change.extra_bags ? bagWords(change.extra_bags) : 'no extra bags'}.`,
          difference > 0
            ? `It costs ${spokenMoney(difference)} more${booking.status === 'paid' ? ', which you pay on the payment page on your phone' : ''}.`
            : difference < 0 ? `The new total is ${spokenMoney(total)}, which is less than before.` : 'The price stays the same.',
          'Shall I make this change?',
        ];
        return { ok: true, needs_confirmation: true, readback: lines.filter(Boolean).join(' ') };
      }

      const changed = await cathay.changeOrder(call.token, ref, change);
      call.pendingChange = null;
      call.changeRef = null;
      call.bookings = null;
      call.ref = changed.ref;
      call.order = changed;
      try { await sendChangeNote(call, changed); } catch (err) { console.error(`[tools] change note for ${ref} not sent: ${err.message}`); }
      if (changed.status === 'held' && config.payment === 'page') {
        openPayPage(call);
        return {
          ok: true, ref, status: 'held', due_hkd: changed.due_hkd,
          say: `Tell him the change is made and that ${spokenMoney(changed.due_hkd)} is to pay: the payment page is now open on his phone, on his trip page. An email comes as soon as it is paid. Stay on the line.`,
        };
      }
      return {
        ok: true, ref, status: changed.status,
        say: changed.status === 'held'
          ? 'Tell him the change is made, and that the booking is now waiting for payment on his trip page. Then ask if there is anything else.'
          : 'Tell him the change is made, that nothing more is to pay, and that an email with his updated trip page is on its way. Then ask if there is anything else.',
      };
    },

    // Rule: general Cathay knowledge comes only from our checked passages (RAG). The model may shorten them for speech,
    // but with no passage it gets nothing to build an answer from, and is told to say so.
    async ask_cathay({ question }, call) {
      const asked = String(question ?? '').trim();
      if (!asked) return fail('Ask him what he would like to know.');
      // deps.knowledge.search returns only passages that are relevant enough; [] means "we do not know".
      const hits = ((await deps.knowledge?.search(asked, MAX_PASSAGES)) ?? []).slice(0, MAX_PASSAGES);
      if (!hits.length) {
        emit(call.id, 'screen', { what: 'knowledge', summary: 'No checked answer on this. CATE offers a member of staff.' });
        return { ok: true, found: false, say: 'Say you do not have that information, and that a member of staff can help. Do not guess.' };
      }
      // The projector shows where the answer comes from: the best passage, its page and the date it was checked.
      const [best] = hits;
      emit(call.id, 'screen', {
        what: 'knowledge',
        summary: `Source: ${best.title} · ${shortSource(best.source)} · checked ${best.checked}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}`,
      });
      return {
        ok: true, found: true,
        passages: hits.map(({ title, text, source, checked }) => ({ title, text, source, checked })),
        say: 'Answer only from these passages, in one or two short sentences, and say it is from the Cathay website. '
          + 'If they do not answer his question, say you do not have that information.',
      };
    },
  };

  /** Runs one tool for the model. Emits tool_call + tool_result. Never throws: problems come back in plain words. */
  async function runTool(name, args, call) {
    const spec = specs.find((s) => s.name === name);
    // Only the inputs a tool declares get through, so a stray phone number or name from the model goes nowhere.
    const input = Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => spec && key in spec.inputSchema.properties));
    emit(call.id, 'tool_call', { name, args: input });
    let result;
    try {
      if (!spec) result = fail(`There is no tool called ${name}.`);
      else if (name !== 'verify_caller' && !call.verified) result = fail('The caller is not verified yet. Ask "Where did you last fly with us?" and call verify_caller first.');
      else result = await handlers[name](input, call, adapterFor(call));
    } catch (err) {
      console.error(`[tools] ${name} failed: ${err.message}`);
      result = fail('That did not work on our side. Say sorry, and try once more.');
    }
    emit(call.id, 'tool_result', { name, result });
    return result;
  }

  return { specs, runTool };
}
