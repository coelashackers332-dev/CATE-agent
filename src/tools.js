// The 8 tools the voice model can call (CONTRACTS.md §3). The model talks; every rule is enforced here.
//
// createTools(deps) → { specs, runTool }
//   deps.cathay   : either a FACTORY (callId) => adapter, e.g. (callId) => createCathay({ callId }), so the projector
//                   lines carry the call id (preferred); or one adapter instance (its lines then carry its own callId).
//   deps.messages : { sendSms(to, body), sendEmail(to, subject, html, text) }
//   deps.texts    : { optionsSms(options, link), payRequestSms(order, travellerName) }
//   deps.emails   : { payEmail({ order, travellerName, payerName, payUrl }) }
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

// ---- Cities we fly in the seed data. Anything else gets "no flights", never a guess.
const CITIES = { HKG: 'Hong Kong', YVR: 'Vancouver', KIX: 'Osaka', NRT: 'Tokyo' };
const cityOf = (code) => CITIES[code] ?? code;
const codeOf = (said) => {
  const s = String(said ?? '').trim().toLowerCase();
  return Object.keys(CITIES).find((code) => code.toLowerCase() === s || CITIES[code].toLowerCase() === s) ?? null;
};

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
      + 'Read out read_out and return_flight slowly, one option at a time. Never say a flight, time or price that is not in the result.',
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
    description: 'Call only after he says yes to "Shall I text these to you?". Sends the options from find_flights to the phone number on his membership. '
      + 'It takes no input: you cannot send to any other number. Then tell him the text is on its way.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_assistance',
    description: 'Call to set wheelchair help before holding the booking. If a recent trip has assistance on file, ask "Same as last time?" and on yes pass same_as_last_trip true. '
      + 'Otherwise ask the three questions in order and pass his answers; stop at the first "no". Read the summary back in plain words. Never say the code.',
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
    description: 'Call with option_id once he has chosen an option and wheelchair help is set. The first call returns a readback: say it to him word for word and ask if it is right. '
      + 'Only after he says yes, call again with the same option_id and caller_confirmed true. Then tell him the booking reference, letter by letter.',
    inputSchema: {
      type: 'object',
      properties: {
        option_id: { type: 'string', description: 'The id of the option he chose, from find_flights' },
        caller_confirmed: { type: 'boolean', description: 'True only after he said yes to the readback' },
      },
      required: ['option_id'],
    },
  },
  {
    name: 'send_pay_link',
    description: 'Call after the booking is held, to send the pay request to the family member on his membership. It takes no input. '
      + 'Tell him who it went to. You will be told when the payment arrives.',
    inputSchema: { type: 'object', properties: {} },
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
    const lastArrival = call.options.map((o) => o.back.arr.slice(0, 10)).sort().at(-1);
    const expires = new Date(Date.parse(lastArrival) + 864e5).toISOString().slice(0, 10);   // the day after the trip
    store.pages.set(call.pageCode, { member_id: call.memberId, options: call.options, ref: call.ref ?? null, expires });
    return `${baseUrl}/v/${call.pageCode}`;
  }

  function readback(option, profile, assistance, payer) {
    const { out, back } = option;
    const wishes = [profile.prefs?.seat && `${profile.prefs.seat} seat`, profile.prefs?.meal && `${profile.prefs.meal} meal`].filter(Boolean).join(', ');
    return [
      `Booking for ${titleCase(profile.name)}.`,
      `${cityOf(out.from)} to ${out.city}, flight ${out.flight}, ${fmtDay(out.dep)}, leaving at ${spokenTime(out.dep)}${option.note ? `, ${option.note}` : ''}.`,
      `Coming back on flight ${back.flight}, ${fmtDay(back.dep)}, leaving at ${spokenTime(back.dep)}.`,
      wishes && `${wishes[0].toUpperCase()}${wishes.slice(1)}.`,
      assistance.summary,
      `The total is ${spokenMoney(option.fare_hkd)} for the return trip.`,
      payer && `${payer} will be asked to pay.`,
      'Shall I hold this booking?',
    ].filter(Boolean).join(' ');
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
      call.verified = true;
      return { ok: true, verified: true, next: 'Call apply_profile now.' };
    },

    async apply_profile(_args, call, cathay) {
      return { ok: true, profile: await profileOf(call, cathay) };
    },

    // Rules: only seeded flights with a fare; ranked by the profile; at most 3; the model gets ready-made sentences.
    async find_flights(args, call, cathay) {
      const to = codeOf(args.to);
      const from = codeOf(args.from ?? 'HKG');
      if (!to || !from || to === from) return fail(`We have no flights for "${args.to}" here. Do not suggest any flight. Ask him which city again.`);
      if (!isDate(args.after) || !isDate(args.before) || args.before <= args.after) {
        return fail('Two dates are needed as YYYY-MM-DD: leave after, and be back before. Ask him for the dates.');
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
      if (!outs.length) return fail('No flights fit those dates. Do not suggest any flight. Ask if other dates would work.');

      const fastest = Math.min(...outs.map(clockHours));
      const noteFor = (f) => {
        if (!f.stops.length) return '';
        const extra = Math.round((clockHours(f) - fastest) * 2) / 2;
        return `via ${f.stops.map(cityOf).join(' and ')}${extra > 0 ? `, ${extra} hours longer` : ''}`;
      };
      const options = outs.map((f, i) => ({ id: String(i + 1), out: segment(f), back: segment(back), fare_hkd: f.return_fare_hkd, note: noteFor(f) }));
      call.options = options;
      call.pendingHold = null;

      const tooEarly = priced.length - fits.length;
      return {
        ok: true,
        options,
        read_out: options.map((o) => `Option ${o.id}: ${fmtDay(o.out.dep)}, leaving at ${spokenTime(o.out.dep)}, ${o.note || 'direct'}, ${spokenMoney(o.fare_hkd)} return.`),
        return_flight: `Every option comes back on ${fmtDay(back.dep)}, leaving at ${spokenTime(back.dep)}.`,
        ...(tooEarly > 0 && { left_out: `${tooEarly} flight${tooEarly === 1 ? '' : 's'} leaving before ${earliest} left out, because he prefers not to leave that early.` }),
      };
    },

    // Rules: only to the number on file, only this call's options. call.callerId IS the number on file:
    // the membership lookup matched it, and it never comes from speech or from the model.
    async text_options(_args, call) {
      if (!call.options?.length) return fail('There are no options to send yet. Find flights first.');
      const link = tripPage(call);
      await deps.messages.sendSms(call.callerId, deps.texts.optionsSms(call.options, link));
      emit(call.id, 'screen', { what: 'sms', summary: `text 1 to the caller: ${call.options.length} options + trip link` });
      emit(call.id, 'screen', { what: 'options_page', summary: 'trip page created', url: link });
      return { ok: true, sent: true, say: 'Tell him the text is on its way to the phone he is calling from, and that the link only shows his trip.' };
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
      call.pendingHold = null;   // any earlier read-back is out of date now
      return { ok: true, ...call.assistance, say: 'Read the summary back in plain words. Never say the code.' };
    },

    // Rules: two steps (read-back, then hold); only an option from this call; name, seat and meal from the profile.
    async hold_booking(args, call, cathay) {
      if (call.ref) return { ok: true, ref: call.ref, status: 'held', already_held: true };
      const option = call.options?.find((o) => o.id === String(args.option_id));
      if (!option) return fail('That is not one of the options from this call. Ask which option he wants.');
      if (!call.assistance) return fail('Ask about wheelchair help first (set_assistance), then hold the booking.');
      const profile = await profileOf(call, cathay);

      const confirmed = yesNo(args.caller_confirmed) === true && call.pendingHold?.option_id === option.id;
      if (!confirmed) {
        const payer = profile.has_delegate ? (await cathay.getDelegate(call.token))?.name ?? null : null;
        call.pendingHold = { option_id: option.id, payer };
        return { ok: true, needs_confirmation: true, readback: readback(option, profile, call.assistance, payer) };
      }

      const order = await cathay.holdOrder(call.token, {
        option_id: option.id, out: option.out, back: option.back, fare_hkd: option.fare_hkd,
        cabin: 'economy', seat: profile.prefs?.seat, meal: profile.prefs?.meal,
        ssr: call.assistance.code ? [call.assistance.code] : [],
        payer: call.pendingHold.payer ?? titleCase(profile.name),
        passenger: profile.name,
      });
      call.ref = order.ref;
      call.order = order;
      call.pendingHold = null;
      tripPage(call);   // the trip page now belongs to this booking (and exists even if no text was sent)
      return {
        ok: true, ref: order.ref, ref_spoken: [...order.ref].join(' '), status: 'held',
        say: 'Tell him the booking is held and read the reference letter by letter. Then offer to send the pay request to his family payer.',
      };
    },

    // Rule: only to the delegate on file with consent. The model cannot name a recipient.
    async send_pay_link(_args, call, cathay) {
      if (!call.ref) return fail('There is no held booking yet. Hold the booking first.');
      if (call.payRequested) return { ok: true, sent_to: call.payRequested, already_sent: true };
      const delegate = await cathay.getDelegate(call.token);
      if (!delegate) return fail('No family payer is on file for him. Say that a member of staff will call him about payment.');
      const first = delegate.name.split(' ')[0];
      const traveller = titleCase(call.order.passenger);
      // PAYMENT=sms: no pay page exists, so the email tells him to reply PAY (payUrl null). With Stripe, payUrl becomes the checkout address.
      const mail = deps.emails.payEmail({ order: call.order, travellerName: traveller, payerName: delegate.name, payUrl: null });
      await deps.messages.sendEmail(delegate.email, mail.subject, mail.html, mail.text);
      emit(call.id, 'screen', { what: 'pay_email', summary: `pay request email to ${first}` });
      if (config.payment === 'sms') {
        await deps.messages.sendSms(delegate.phone, deps.texts.payRequestSms(call.order, traveller));
        emit(call.id, 'screen', { what: 'sms', summary: `pay request text to ${first}: "Reply PAY"` });
      }
      call.payRequested = first;
      return { ok: true, sent_to: first };
    },

    // Rule: general Cathay knowledge comes only from our checked passages (RAG). The model may shorten them for speech,
    // but with no passage it gets nothing to build an answer from, and is told to say so.
    async ask_cathay({ question }, _call) {
      const asked = String(question ?? '').trim();
      if (!asked) return fail('Ask him what he would like to know.');
      // deps.knowledge.search returns only passages that are relevant enough; [] means "we do not know".
      const hits = (await deps.knowledge?.search(asked, MAX_PASSAGES)) ?? [];
      if (!hits.length) {
        return { ok: true, found: false, say: 'Say you do not have that information, and that a member of staff can help. Do not guess.' };
      }
      return {
        ok: true, found: true,
        passages: hits.slice(0, MAX_PASSAGES).map(({ title, text, source, checked }) => ({ title, text, source, checked })),
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
