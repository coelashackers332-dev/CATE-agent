// The golden path and the refusals, through runTool, with the real adapter + mock Cathay and stub messages/screens.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { store } from '../src/store.js';
import { bus } from '../src/events.js';
import { config } from '../src/config.js';
import { createCathay } from '../src/cathay.js';
import { createTools } from '../src/tools.js';
import { handleMockCathay } from '../src/mock-cathay/routes.js';

const BASE_URL = 'https://cate.example';
let server, base, events, sent, tools, call;
const record = (ev) => events.push(ev);

before(async () => {
  server = createServer((req, res) => {
    if (!handleMockCathay(req, res)) { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const newCall = (id = 'c1', callerId = store.members[0].phone) => ({
  id, callerId, memberId: null, token: null, verified: false, options: [],
  pageCode: null, pendingHold: null, assistance: null, ref: null, session: null,
});

// Each test sees PAYMENT=sms unless it sets another mode itself, whatever the local .env says.
const PAYMENT_IN_ENV = config.payment;
afterEach(() => { config.payment = PAYMENT_IN_ENV; });

beforeEach(() => {
  config.payment = 'sms';
  store.reset({ log: false });
  events = [];
  sent = { sms: [], email: [] };
  bus.on('event', record);
  tools = createTools({
    cathay: (callId) => createCathay({ base, callId }),
    messages: {
      sendSms: async (to, body) => { sent.sms.push({ to, body }); },
      sendEmail: async (to, subject, html, text) => { sent.email.push({ to, subject, html, text }); },
    },
    texts: {
      optionsSms: (options, link) => `OPTIONS ${options.map((o) => o.id).join(',')} ${link}`,
      payRequestSms: (order, travellerName) => `PAYREQ ${order.ref} ${travellerName}`,
    },
    emails: {
      payEmail: ({ order, travellerName, payerName, payUrl }) => ({ subject: `Pay ${order.ref}`, html: `<p>${payerName}</p>`, text: `${travellerName} ${payUrl}` }),
    },
    knowledge: { search: async (question, limit) => knowledge(question).slice(0, limit) },
    baseUrl: BASE_URL,
  });
  call = newCall();
});
afterEach(() => bus.off('event', record));

// Stub knowledge search: 4 baggage passages for a baggage question, nothing for anything else.
const PASSAGE = { title: 'Checked baggage', text: 'Economy includes one checked bag.', source: 'https://www.cathaypacific.com/baggage', checked: '2026-11-13', score: 0.9 };
const knowledge = (question) => (/bag/i.test(question) ? [PASSAGE, PASSAGE, PASSAGE, PASSAGE] : []);

const run = (name, args) => tools.runTool(name, args, call);
const VANCOUVER = { to: 'Vancouver', after: '2027-02-06', before: '2027-04-05' };
const verify = () => run('verify_caller', { answer: 'Osaka, last May' });

test('specs: the 10 tools, each with a description and a JSON Schema', () => {
  assert.deepEqual(tools.specs.map((s) => s.name), ['verify_caller', 'apply_profile', 'find_flights', 'text_options', 'choose_option', 'set_preferences', 'set_assistance', 'hold_booking', 'send_pay_link', 'ask_cathay']);
  for (const s of tools.specs) {
    assert.ok(s.description.length > 40, s.name);
    assert.equal(s.inputSchema.type, 'object');
    assert.equal(typeof s.inputSchema.properties, 'object');
  }
});

test('golden path: verify → profile → flights → text → assistance → hold → pay link', { skip: !config.demoMode && 'DEMO_MODE is off' }, async () => {
  const wong = store.members[0];
  const daniel = wong.delegates[0];

  // 1. verify
  assert.deepEqual(await verify(), { ok: true, verified: true, next: 'Call apply_profile now.' });
  assert.equal(call.memberId, 'DEMO-0001');
  assert.ok(store.sessions.has(call.token));

  // 2. profile: the shape in DATA.md §4
  const { profile } = await run('apply_profile', {});
  assert.equal(profile.name, 'WONG TAK MING');
  assert.deepEqual(profile.prefs, { seat: 'window', meal: 'vegetarian', bags: 1, earliest_departure: '09:00' });
  assert.equal(profile.has_delegate, true);
  assert.deepEqual(profile.recent_trips, [{ to: 'Osaka', month: '2026-05', status: 'flown', ssr: ['WCHR'], assistance: 'Wheelchair from check-in to the gate. Can manage stairs and walk to the seat.' }]);

  // 3. flights: exactly the golden-path expectation in CONTRACTS.md
  const found = await run('find_flights', VANCOUVER);
  const back = { flight: 'CX0V2', from: 'YVR', to: 'HKG', city: 'Hong Kong', dep: '2027-03-31T13:30', arr: '2027-04-01T18:30', stops: [] };
  assert.deepEqual(found.options, [
    { id: '1', out: { flight: 'CX0V1', from: 'HKG', to: 'YVR', city: 'Vancouver', dep: '2027-02-19T11:40', arr: '2027-02-19T07:40', stops: [] }, back, fare_hkd: 8420, note: '' },
    { id: '2', out: { flight: 'CX0V3', from: 'HKG', to: 'YVR', city: 'Vancouver', dep: '2027-02-19T23:50', arr: '2027-02-19T19:50', stops: [] }, back, fare_hkd: 7960, note: '' },
    { id: '3', out: { flight: 'CX0T1', from: 'HKG', to: 'YVR', city: 'Vancouver', dep: '2027-02-19T09:10', arr: '2027-02-19T09:40', stops: ['NRT'] }, back, fare_hkd: 6900, note: 'via Tokyo, 4.5 hours longer' },
  ]);
  assert.equal(found.read_out[0], 'The first option leaves on Friday 19 February at 11:40 am. It is direct, and costs 8,420 Hong Kong dollars return.');
  assert.equal(found.read_out[1], 'The second option leaves on Friday 19 February at 11:50 pm. It is direct, and costs 7,960 Hong Kong dollars return.');
  assert.equal(found.return_flight, 'Every option comes back on Wednesday 31 March, leaving at 1:30 pm.');
  assert.equal(found.left_out, 'I left out 1 flight that leaves before 9:00 am, because you prefer not to leave that early.');
  assert.ok(!JSON.stringify(found).includes('06:30'), 'the 06:30 flight is filtered out');
  assert.equal(call.options, found.options);

  // 4. text the options: to the number on file, with the trip page link
  assert.equal((await run('text_options', { phone: '+85212345678' })).ok, true);
  const link = `${BASE_URL}/v/${call.pageCode}`;
  assert.deepEqual(sent.sms, [{ to: wong.phone, body: `OPTIONS 1,2,3 ${link}` }]);
  assert.deepEqual(store.pages.get(call.pageCode), { member_id: 'DEMO-0001', options: found.options, ref: null, expires: '2027-04-02' });

  // 5. his answers, one tool each: every result says the answer back and gives the one next question
  const chosen = await run('choose_option', { option_id: '1' });
  assert.equal(chosen.confirm, 'The first option: Friday 19 February at 11:40 am, direct, 8,420 Hong Kong dollars return.');
  assert.match(chosen.next, /Your membership has a window seat and a vegetarian meal\. Is that still right\?/);
  const kept = await run('set_preferences', { seat_ok: true, meal_ok: true });
  assert.equal(kept.confirm, 'A window seat and a vegetarian meal, as on your membership.');
  assert.match(kept.next, /On your Osaka trip we arranged this: Wheelchair from check-in to the gate\. .* Would you like the same help again\?/);
  // assistance: "like Osaka?" → the SSR of the latest flown order
  const same = await run('set_assistance', { same_as_last_trip: true });
  assert.equal(same.code, 'WCHR');
  assert.deepEqual(call.assistance, { code: 'WCHR', summary: 'Wheelchair from check-in to the gate. Can manage stairs and walk to the seat.' });
  // the member pays himself: nobody is asked who pays, the read-back comes next
  assert.match(same.next, /call hold_booking now, in this same turn/);
  assert.doesNotMatch(same.next, /Daniel|who pays/);

  // 6. hold: read-back first, then the hold
  const first = await run('hold_booking', { option_id: '1' });
  assert.equal(first.needs_confirmation, true);
  assert.equal(first.ref, undefined);
  assert.equal(first.readback, 'Let me read it all back to you. Nothing is booked until you say yes. Booking for Wong Tak Ming. Hong Kong to Vancouver, flight CX0V1, Friday 19 February, leaving at 11:40 am. '
    + 'Coming back on flight CX0V2, Wednesday 31 March, leaving at 1:30 pm. Window seat, vegetarian meal. '
    + 'Wheelchair from check-in to the gate. Can manage stairs and walk to the seat. '
    + 'The total is 8,420 Hong Kong dollars for the return trip. The pay request will come to your own phone. Shall I hold this booking?');
  assert.deepEqual(call.pendingHold, { option_id: '1' });
  assert.equal(store.orders.length, 1);

  const held = await run('hold_booking', { option_id: '1', caller_confirmed: true });
  assert.equal(held.ok, true);
  assert.equal(held.ref, 'K7Q2XM');
  assert.equal(held.ref_spoken, 'K 7 Q 2 X M');
  assert.equal(call.ref, 'K7Q2XM');
  assert.equal(call.pendingHold, null);
  assert.deepEqual(store.orders.at(-1), {
    ref: 'K7Q2XM', member_id: 'DEMO-0001', status: 'held', option_id: '1',
    out: found.options[0].out, back, fare_hkd: 8420,
    cabin: 'economy', seat: 'window', meal: 'vegetarian', ssr: ['WCHR'], payer: 'Wong Tak Ming', passenger: 'WONG TAK MING',
  });
  assert.equal(store.pages.get(call.pageCode).ref, 'K7Q2XM');
  assert.equal((await run('hold_booking', { option_id: '2', caller_confirmed: true })).ref, 'K7Q2XM', 'one hold per call');
  assert.equal(store.orders.length, 2);

  // 7. pay request (PAYMENT=sms): only to his own number on file, whatever the model passes; nothing to the family
  assert.equal((await run('send_pay_link', { to: 'someone@else.example' })).sent_to, 'his own phone');
  assert.deepEqual(sent.sms.at(-1), { to: wong.phone, body: 'PAYREQ K7Q2XM Wong Tak Ming' });
  assert.equal(sent.email.length, 0);
  assert.equal((await run('send_pay_link', {})).already_sent, true);
  assert.equal(sent.sms.length, 2);

  // events: one tool_call + one tool_result per run, system lines from the adapter, screens from the tools
  const kinds = (k) => events.filter((e) => e.kind === k);
  assert.equal(kinds('tool_call').length, kinds('tool_result').length);
  assert.equal(kinds('tool_call').length, 12);
  assert.deepEqual(kinds('tool_call')[3].args, {}, 'undeclared inputs are dropped');
  assert.deepEqual(kinds('screen').map((e) => e.what), ['sms', 'options_page', 'sms']);
  assert.ok(events.every((e) => e.call_id === 'c1'));
  assert.ok(kinds('system').some((e) => e.summary === 'K7Q2XM · WCHR'));
  const text = JSON.stringify(events);
  for (const secret of [wong.phone, wong.email, daniel.phone, daniel.email, '+85212345678', 'someone@else.example']) {
    assert.ok(!text.includes(secret), `events must not carry ${secret}`);
  }

  // the next call hears about this trip ("Same as your Vancouver trip?")
  call = newCall('c2');
  await verify();
  const again = (await run('apply_profile', {})).profile.recent_trips;
  assert.deepEqual(again.map((t) => [t.to, t.month, t.status]), [['Vancouver', '2027-02', 'held'], ['Osaka', '2026-05', 'flown']]);
});

test('set_assistance: the fixed table gives WCHC, WCHS, WCHR or none', async () => {
  await verify();
  const table = [
    [{ walk_in_cabin: false }, 'WCHC'],
    [{ walk_in_cabin: true, stairs: false }, 'WCHS'],
    [{ walk_in_cabin: true, stairs: true, long_distance: false }, 'WCHR'],
    [{ walk_in_cabin: true, stairs: true, long_distance: true }, null],
    [{ walk_in_cabin: false, stairs: true, long_distance: true }, 'WCHC'],
    [{ walk_in_cabin: 'yes', stairs: 'no' }, 'WCHS'],
  ];
  for (const [answers, code] of table) {
    const result = await run('set_assistance', answers);
    assert.equal(result.ok, true);
    assert.equal(result.code, code, JSON.stringify(answers));
    assert.ok(result.summary.length > 10);
    assert.ok(!/WCH/.test(result.summary), 'the summary is plain words');
    assert.deepEqual(call.assistance, { code, summary: result.summary });
  }
  assert.equal(call.assistance.summary, 'Wheelchair from check-in to the aircraft door, with help on stairs. Can walk to the seat on the plane.');
});

test('set_assistance: missing answers are asked for, not guessed', async () => {
  await verify();
  const result = await run('set_assistance', { walk_in_cabin: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /stairs/);
  assert.equal(call.assistance, null);
  // "same as last time" with nothing on file → ask the questions
  store.orders[0].ssr = [];
  assert.equal((await run('set_assistance', { same_as_last_trip: true })).ok, false);
  assert.equal(call.assistance, null);
});

test('nothing about the member before verification', async () => {
  for (const [name, args] of [['apply_profile', {}], ['find_flights', VANCOUVER], ['text_options', {}], ['set_assistance', { same_as_last_trip: true }], ['hold_booking', { option_id: '1', caller_confirmed: true }], ['send_pay_link', {}]]) {
    const result = await run(name, args);
    assert.equal(result.ok, false, name);
    assert.match(result.error, /not verified/);
    assert.deepEqual(Object.keys(result), ['ok', 'error'], name);
  }
  assert.equal(events.filter((e) => e.kind === 'system').length, 0, 'no Cathay system was touched');
  assert.equal(sent.sms.length + sent.email.length, 0);
});

test('a wrong answer does not verify, tells the model nothing, and three wrong answers end it', async () => {
  for (let i = 0; i < 3; i += 1) {
    const result = await run('verify_caller', { answer: 'Tokyo, in March' });
    assert.equal(result.ok, false);
    assert.equal(result.verified, false);
  }
  assert.equal(call.verified, false);
  assert.equal(call.token, null);
  assert.ok(!/osaka|may|wong/i.test(JSON.stringify(events.filter((e) => e.kind === 'tool_result'))), 'no hint of the right answer or the member');
  const locked = await run('verify_caller', { answer: 'Osaka, last May' });
  assert.equal(locked.verified, false);
  assert.equal((await run('apply_profile', {})).ok, false);
});

test('an unknown calling number cannot verify', async () => {
  call = newCall('c9', '+85299999999');
  const result = await run('verify_caller', { answer: 'Osaka, last May' });
  assert.equal(result.verified, false);
  assert.equal(call.memberId, null);
});

test('hold_booking without a read-back confirmation creates nothing', async () => {
  await verify();
  await run('find_flights', VANCOUVER);
  assert.match((await run('hold_booking', { option_id: '1', caller_confirmed: true })).error, /Is that still right/, 'seat and meal are asked first');
  await run('set_preferences', { seat_ok: true, meal_ok: true });
  await run('set_payer', { payer: 'family' });
  assert.match((await run('hold_booking', { option_id: '1', caller_confirmed: true })).error, /wheelchair/i, 'then wheelchair help');
  await run('set_assistance', { walk_in_cabin: true, stairs: true, long_distance: true });

  // "confirmed" with no read-back before it → it gets the read-back step, not a booking
  const jumped = await run('hold_booking', { option_id: '1', caller_confirmed: true });
  assert.equal(jumped.needs_confirmation, true);
  assert.equal(jumped.ref, undefined);
  assert.match(jumped.readback, /No wheelchair needed\./);

  // confirming a different option than the one read back → read-back again
  const other = await run('hold_booking', { option_id: '2', caller_confirmed: true });
  assert.equal(other.needs_confirmation, true);
  assert.match(other.readback, /11:50 pm/);

  // changing the assistance after the read-back → read-back again
  await run('set_assistance', { walk_in_cabin: false });
  const changed = await run('hold_booking', { option_id: '2', caller_confirmed: true });
  assert.equal(changed.needs_confirmation, true);

  // an option that was never offered
  assert.equal((await run('hold_booking', { option_id: '7', caller_confirmed: true })).ok, false);

  assert.equal(store.orders.length, 1);
  assert.equal(call.ref, null);
  assert.equal((await run('send_pay_link', {})).ok, false, 'no pay request without a hold');
  assert.equal(sent.email.length, 0);

  const held = await run('hold_booking', { option_id: '2', caller_confirmed: true });
  assert.equal(held.ok, true);
  assert.deepEqual(store.orders.at(-1).ssr, ['WCHC']);
  assert.ok(store.pages.get(call.pageCode), 'the trip page exists even when no text was sent');
});

test('an unknown city or impossible dates return no flight at all', async () => {
  await verify();
  for (const args of [
    { to: 'Atlantis', after: '2027-02-06', before: '2027-04-05' },
    { to: 'Hong Kong', after: '2027-02-06', before: '2027-04-05' },
    { to: 'Osaka', after: '2027-02-06', before: '2027-04-05' },      // a known city with no seeded flights
    { to: 'Vancouver', after: '2028-01-01', before: '2028-02-01' },  // no flights in these dates
    { to: 'Vancouver', after: 'next week', before: '2027-04-05' },
    { to: 'Vancouver', after: '2027-04-05', before: '2027-02-06' },
  ]) {
    const result = await run('find_flights', args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.options, undefined);
    assert.ok(!/CX\d|HKD|\d{2}:\d{2}/.test(result.error), 'no invented flight, fare or time');
  }
  assert.deepEqual(call.options, []);
  assert.equal((await run('text_options', {})).ok, false);
  assert.equal(store.pages.size, 0);
});

test('find_flights accepts airport codes and any letter case', async () => {
  await verify();
  assert.equal((await run('find_flights', { ...VANCOUVER, to: 'yvr' })).options.length, 3);
  assert.equal((await run('find_flights', { ...VANCOUVER, to: ' VANCOUVER ', from: 'hong kong' })).options.length, 3);
});

test('runTool never throws: an unknown tool or a broken system comes back in plain words', async () => {
  assert.deepEqual(await run('delete_everything', {}), { ok: false, error: 'There is no tool called delete_everything.' });
  await verify();
  await run('find_flights', VANCOUVER);
  const broken = createTools({
    cathay: (callId) => createCathay({ base, callId }),
    messages: { sendSms: async () => { throw new Error('carrier down +85200000001'); } },
    texts: { optionsSms: () => 'x' },
    emails: {},
    baseUrl: BASE_URL,
  });
  const result = await broken.runTool('text_options', {}, call);
  assert.equal(result.ok, false);
  assert.ok(!result.error.includes('carrier'), 'internal errors are not read to the caller');
  assert.equal(events.at(-1).kind, 'tool_result');
});

test('ask_cathay: answers only from passages, says so when there are none, and needs verification', async () => {
  const early = await run('ask_cathay', { question: 'How many bags can I bring?' });
  assert.equal(early.ok, false);                       // not verified yet
  assert.equal(early.passages, undefined);

  await verify();
  const hit = await run('ask_cathay', { question: 'How many bags can I bring?' });
  assert.equal(hit.found, true);
  assert.equal(hit.passages.length, 3);                // at most 3, even if the search returns more
  assert.deepEqual(hit.passages[0], { title: PASSAGE.title, text: PASSAGE.text, source: PASSAGE.source, checked: PASSAGE.checked });
  assert.match(hit.say, /only from these passages/);
  // The projector gets the source of the answer: title, page without "https://www.", date checked.
  const shown = () => events.filter((e) => e.kind === 'screen' && e.what === 'knowledge').at(-1).summary;
  assert.equal(shown(), 'Source: Checked baggage · cathaypacific.com/baggage · checked 2026-11-13 (+2 more)');

  const miss = await run('ask_cathay', { question: 'Do I need a visa for Canada?' });
  assert.deepEqual([miss.ok, miss.found, miss.passages], [true, false, undefined]);
  assert.match(miss.say, /do not have that information/);
  assert.match(shown(), /^No checked answer/);

  assert.equal((await run('ask_cathay', { question: '  ' })).ok, false);

  // With no knowledge base wired in, the tool still answers safely.
  const bare = createTools({ cathay: (callId) => createCathay({ base, callId }), baseUrl: BASE_URL });
  assert.equal((await bare.runTool('ask_cathay', { question: 'bags?' }, call)).found, false);
});

test('the member always pays himself: no who-pays question, no set_payer tool, nothing to the family payer', async () => {
  await verify();
  await run('find_flights', VANCOUVER);
  await run('choose_option', { option_id: '1' });
  // a wish for another seat or meal is recorded and answered honestly, never invented
  const change = await run('set_preferences', { seat_ok: true, meal_ok: false });
  assert.equal(change.confirm, 'I will keep the window seat. On this call I can only book the vegetarian meal on your membership. A member of staff can change the meal after booking.');
  await run('set_assistance', { same_as_last_trip: true });
  assert.equal((await run('set_payer', { payer: 'family' })).ok, false, 'there is no set_payer tool any more');
  const first = await run('hold_booking', {});
  assert.match(first.readback, /The pay request will come to your own phone\. Shall I hold this booking\?$/);
  const held = await run('hold_booking', { caller_confirmed: true });
  assert.equal(held.ref, 'K7Q2XM');
  assert.equal(store.orders.at(-1).payer, 'Wong Tak Ming');
  assert.equal((await run('send_pay_link', {})).sent_to, 'his own phone');
  assert.deepEqual(sent.sms.at(-1), { to: store.members[0].phone, body: 'PAYREQ K7Q2XM Wong Tak Ming' });
  assert.equal(sent.email.length, 0);
});

test('no flights for the dates: the days we do fly are named, with no flight, fare or time', async () => {
  await verify();
  const none = await run('find_flights', { to: 'Vancouver', after: '2027-01-01', before: '2027-01-16' });
  assert.equal(none.ok, false);
  assert.match(none.error, /We fly to Vancouver on Friday 19 February, Saturday 20 February, and back on Wednesday 31 March/);
});

test('no flights for the dates: with the full schedule only the first days from his date are named', async () => {
  await verify();
  const none = await run('find_flights', { to: 'London', after: '2026-12-20', before: '2026-12-20' });
  assert.equal(none.ok, false);
  const named = none.error.match(/We fly to London on (.*?), and back/)?.[1] ?? '';
  assert.ok(named.split(', ').length <= 5 + 1, named);   // five days, then "and most days after that"
  assert.match(named, /^Monday 21 December, .* and most days after that$/);   // the window starts after his date
});

test('cities: every airport in the schedule is known by its city name, and common other names work', async () => {
  await verify();
  for (const city of ['London', 'Tokyo Haneda', 'Saigon', 'Bangalore']) {
    const found = await run('find_flights', { to: city, after: '2026-11-20', before: '2026-12-10' });
    // a known city: never "no flights for <city>" (his "not too early" may still rule out every flight on some routes)
    assert.doesNotMatch(found.error ?? '', /We have no flights for/, city);
  }
  assert.match((await run('find_flights', { to: 'Atlantis', after: '2026-11-20', before: '2026-12-10' })).error, /We have no flights for/);
});

test('demo trip: after Christmas 2026, back before New Year, finds options (the OAG schedule ends 31 Dec 2026)', async () => {
  await verify();
  for (const to of ['Osaka', 'Tokyo', 'Vancouver', 'London', 'Singapore', 'Taipei', 'Bangkok', 'Sydney']) {
    const found = await run('find_flights', { to, after: '2026-12-25', before: '2027-01-01' });
    if (process.env.SHOW_DEMO) console.log(to, found.ok ? found.read_out.join(' ') + ' ' + found.return_flight : found.error);
    if (['Osaka', 'Tokyo', 'Vancouver'].includes(to)) assert.equal(found.ok, true, to);
  }
});

test('PAYMENT=page: the options go to his trip page at once, the hold opens the payment page, and no pay request is sent', async () => {
  config.payment = 'page';
  await verify();
  const found = await run('find_flights', VANCOUVER);
  assert.equal(sent.sms.length, 1, 'the options and trip link are sent without asking');
  assert.match(sent.sms[0].body, /^OPTIONS 1/);
  assert.match(found.next, /on his trip page, in the email we just sent/);
  assert.doesNotMatch(found.next, /Shall I text these/);
  await run('find_flights', VANCOUVER);
  assert.equal(sent.sms.length, 1, 'a new search refreshes the same page, it does not send again');
  assert.equal((await run('text_options', {})).ok, true, 'he can still ask for it again');
  assert.equal(sent.sms.length, 2);
  await run('choose_option', { option_id: '1' });
  await run('set_preferences', { seat_ok: true, meal_ok: true });
  await run('set_assistance', { same_as_last_trip: true });
  assert.match((await run('hold_booking', {})).readback, /Once it is held, the payment page opens on your phone\. Shall I hold this booking\?$/);
  const held = await run('hold_booking', { caller_confirmed: true });
  assert.equal(held.sent_to, 'his trip page', 'the hold itself opens the payment page');
  assert.match(held.say, /payment page is now open on his phone/);
  assert.doesNotMatch(held.say, /send_pay_link/);
  assert.equal(call.payRequested, 'his trip page');
  const pay = await run('send_pay_link', {});
  assert.equal(pay.already_sent, true);
  assert.equal(sent.email.length, 0);
  assert.equal(sent.sms.length, 2, 'no "Reply PAY" text');
});
