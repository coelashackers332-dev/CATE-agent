// The golden path and the refusals, through runTool, with the real adapter + mock Cathay and stub messages/screens.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { store, setOrderStatus } from '../src/store.js';
import { bus, emit } from '../src/events.js';
import { config } from '../src/config.js';
import { createCathay } from '../src/cathay.js';
import { createTools } from '../src/tools.js';
import { handleMockCathay } from '../src/mock-cathay/routes.js';
import { existsSync as demoFileExists } from 'node:fs';
const HAS_DEMO = demoFileExists(new URL('../src/model/prompt_demo.js', import.meta.url));   // demo mode is optional

// The full call unless a test asks for the demo one: a PROMPT=demo in .env must not change what these tests check.
delete process.env.PROMPT;

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
    knowledge: { search: async (question, limit) => knowledge(question).slice(0, limit) },
    baseUrl: BASE_URL,
  });
  call = newCall();
});
afterEach(() => bus.off('event', record));

// Stub knowledge search: 4 baggage passages for a baggage question, nothing for anything else.
const PASSAGE = { title: 'Checked baggage', text: 'Economy includes one checked bag.', source: 'https://www.cathaypacific.com/baggage', checked: '2026-11-13', score: 0.9 };
const knowledge = (question) => (/bag/i.test(question) ? [PASSAGE, PASSAGE, PASSAGE, PASSAGE] : []);

// A confirmed hold needs CATE to have asked the read-back's question out loud first, as Nova reports each sentence it speaks.
const run = (name, args) => {
  if (name === 'hold_booking' && args?.caller_confirmed === true) emit(call.id, 'cate_said', { text: 'Shall I hold this booking?' });
  if (name === 'verify_caller') emit(call.id, 'caller_said', { text: String(args?.code ?? '') });   // he reads the code out
  return tools.runTool(name, args, call);
};
const VANCOUVER = { to: 'Vancouver', after: '2027-02-06', before: '2027-04-05' };
// The caller gets the code by email and reads it out: call.sentCode is what the email said.
const verify = async () => {
  await run('send_code', {});
  const result = await run('verify_caller', { code: call.sentCode });
  sent.sms = sent.sms.filter((m) => !/your code is/.test(m.body));   // the tests below count the messages after verification
  return result;
};

test('specs: the 16 tools, each with a description and a JSON Schema', () => {
  assert.deepEqual(tools.specs.map((s) => s.name), ['send_code', 'verify_caller', 'apply_profile', 'find_flights', 'text_options', 'choose_option', 'set_preferences', 'set_baggage', 'set_special_request', 'keep_as_last_time', 'set_assistance', 'hold_booking', 'send_pay_link', 'find_booking', 'change_booking', 'ask_cathay']);
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
  assert.deepEqual(profile.prefs, { seat: 'window', seat_area: 'front', meal: 'vegetarian', bags: 1, earliest_departure: '09:00' });
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
  assert.deepEqual(store.pages.get(call.pageCode), { member_id: 'DEMO-0001', options: found.options, ref: null, expires: '2027-04-02', summary: null });

  // 5. his answers, one tool each: every result says the answer back and gives the one next question
  const chosen = await run('choose_option', { option_id: '1' });
  assert.equal(chosen.confirm, 'The first option: Friday 19 February at 11:40 am, direct, 8,420 Hong Kong dollars return.');
  assert.match(chosen.next, /Your membership has a window seat near the front of the cabin and a vegetarian meal\. Is that still right\?/);
  const kept = await run('set_preferences', { seat_ok: true, meal_ok: true });
  assert.equal(kept.confirm, 'A window seat near the front of the cabin and a vegetarian meal, as on your membership.');
  assert.match(kept.next, /On your Osaka trip we arranged this: Wheelchair from check-in to the gate\. .* Would you like the same help again\?/);
  // assistance: "like Osaka?" → the SSR of the latest flown order
  const same = await run('set_assistance', { same_as_last_trip: true });
  assert.equal(same.code, 'WCHR');
  assert.deepEqual(call.assistance, { code: 'WCHR', summary: 'Wheelchair from check-in to the gate. Can manage stairs and walk to the seat.' });
  // then baggage (with the fee from the Orders system) and anything else to arrange, one question each
  assert.match(same.next, /Your membership has 1 checked bag\. Would you like any extra baggage\? It is 500 Hong Kong dollars a bag\?/);
  const noBags = await run('set_baggage', { extra_bags: 0 });
  assert.equal(noBags.confirm, 'No extra baggage.');
  assert.match(noBags.next, /Is there anything else we should arrange for this trip/);
  const nothing = await run('set_special_request', { none: true });
  // the member pays himself: nobody is asked who pays, the read-back comes next
  assert.match(nothing.next, /call hold_booking now, in this same turn/);
  assert.doesNotMatch(nothing.next, /Daniel|who pays/);

  // 6. hold: read-back first, then the hold
  const first = await run('hold_booking', { option_id: '1' });
  assert.equal(first.needs_confirmation, true);
  assert.equal(first.ref, undefined);
  assert.equal(first.readback, 'Let me read it all back to you. Nothing is booked until you say yes. Booking for Wong Tak Ming, with the passport on your membership. Hong Kong to Vancouver, flight CX0V1, Friday 19 February, leaving at 11:40 am. '
    + 'Coming back on flight CX0V2, Wednesday 31 March, leaving at 1:30 pm. A window seat near the front of the cabin, a vegetarian meal. '
    + 'Wheelchair from check-in to the gate. Can manage stairs and walk to the seat. '
    + 'The total is 8,420 Hong Kong dollars for the return trip. The pay request will come to your own phone. Shall I hold this booking?');
  assert.deepEqual(call.pendingHold, { option_id: '1' });
  assert.equal(store.orders.length, 2);

  const held = await run('hold_booking', { option_id: '1', caller_confirmed: true });
  assert.equal(held.ok, true);
  assert.equal(held.ref, 'K7Q2XM');
  assert.equal(held.ref_spoken, 'K 7 Q 2 X M');
  assert.equal(call.ref, 'K7Q2XM');
  assert.equal(call.pendingHold, null);
  assert.deepEqual(store.orders.at(-1), {
    ref: 'K7Q2XM', member_id: 'DEMO-0001', status: 'held', option_id: '1',
    out: found.options[0].out, back, fare_hkd: 8420,
    cabin: 'economy', seat: 'window', seat_area: 'front', meal: 'vegetarian',
    extra_bags: 0, extras_hkd: 0, total_hkd: 8420, due_hkd: 8420, requests: [],
    ssr: ['WCHR'], passport: 'HKG passport ending 478', payer: 'Wong Tak Ming', passenger: 'WONG TAK MING',
  });
  assert.equal(store.pages.get(call.pageCode).ref, 'K7Q2XM');
  assert.equal((await run('hold_booking', { option_id: '2', caller_confirmed: true })).ref, 'K7Q2XM', 'one hold per call');
  assert.equal(store.orders.length, 3);

  // 7. pay request (PAYMENT=sms): only to his own number on file, whatever the model passes; nothing to the family
  assert.equal((await run('send_pay_link', { to: 'someone@else.example' })).sent_to, 'his own phone');
  assert.deepEqual(sent.sms.at(-1), { to: wong.phone, body: 'PAYREQ K7Q2XM Wong Tak Ming' });
  assert.equal(sent.email.length, 0);
  assert.equal((await run('send_pay_link', {})).already_sent, true);
  assert.equal(sent.sms.length, 2);

  // events: one tool_call + one tool_result per run, system lines from the adapter, screens from the tools
  const kinds = (k) => events.filter((e) => e.kind === k);
  assert.equal(kinds('tool_call').length, kinds('tool_result').length);
  assert.equal(kinds('tool_call').length, 15, 'send_code added the first call');
  assert.deepEqual(kinds('tool_call')[4].args, {}, 'undeclared inputs are dropped');
  assert.deepEqual(kinds('screen').map((e) => e.what), ['code', 'tier', 'sms', 'options_page', 'sms']);
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
  call.profile = null;   // read again, as on a new call
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

test('a wrong code does not verify, tells the model nothing, and three wrong codes end it', async () => {
  assert.equal((await run('verify_caller', { code: '123456' })).verified, false, 'no code sent yet: nothing to check');
  const sent = await run('send_code', {});
  assert.equal(sent.ok, true);
  assert.ok(!JSON.stringify(sent).includes(call.sentCode), 'the model never sees the code');
  assert.equal((await run('verify_caller', { code: '12' })).verified, false, 'too short: asked again, not counted');
  for (let i = 0; i < 3; i += 1) {
    const result = await run('verify_caller', { code: call.sentCode === '000000' ? '111111' : '000000' });
    assert.equal(result.ok, false);
    assert.equal(result.verified, false);
  }
  assert.equal(call.verified, false);
  assert.equal(call.token, null);
  assert.ok(!/osaka|may|wong/i.test(JSON.stringify(events.filter((e) => e.kind === 'tool_result'))), 'no hint of the member');
  const locked = await run('verify_caller', { code: call.sentCode });
  assert.equal(locked.verified, false, 'locked after three wrong codes, even with the right one');
  assert.equal((await run('apply_profile', {})).ok, false);
});

test('the code goes by text-as-email to the number on file, read with spaces, and works only once', async () => {
  await run('send_code', {});
  const msg = sent.sms.at(-1);
  assert.ok(msg, 'one message sent');
  assert.ok(msg.body.includes(`${call.sentCode.slice(0, 3)} ${call.sentCode.slice(3)}`));
  assert.equal((await run('verify_caller', { code: call.sentCode.split('').join(' ') })).verified, true, 'spoken digits with spaces pass');
  call = newCall('c2');
  call.codesSent = 1;   // pretend a code went out, but use the old one
  assert.equal((await run('verify_caller', { code: '000000' })).verified, false);
});

test('an unknown calling number gets no code and cannot verify', async () => {
  call = newCall('c9', '+85299999999');
  const result = await run('send_code', {});
  assert.equal(result.ok, false);
  assert.equal(call.memberId, null);
  assert.equal((await run('verify_caller', { code: '123456' })).verified, false);
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

  assert.equal(store.orders.length, 2, 'only the 2 seeded trips');
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
  assert.match((await run('set_preferences', { seat_ok: true, meal_ok: false })).error, /Ask which meal/, 'a different meal is asked for, never guessed');
  const change = await run('set_preferences', { seat_ok: true, meal_ok: false, meal: 'vegan' });
  assert.equal(change.confirm, 'A window seat near the front of the cabin and a vegan meal.');
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

// ---- GAME-PLAN 2026-11-15: tier gate, seat, meal, baggage, special requests, managing a booking

const CHAN = '+85200000003';   // seeded Green member, no assistance need, last flew to Taipei

test('tier gate: a Green member without an assistance need is refused after verification, and gets nothing', async () => {
  call = newCall('c1', CHAN);
  const result = await verify();
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.error, /Gold members and above/);
  assert.equal(call.verified, false);
  assert.equal(call.token, null);
  assert.equal((await run('find_flights', { to: 'Osaka', after: '2026-12-25', before: '2027-01-01' })).ok, false, 'no tool works after a refusal');
  assert.ok(events.some((e) => e.kind === 'screen' && e.what === 'tier' && /Green member: CATE is for Gold/.test(e.summary)));
});

test('tier gate: a Green member with a registered assistance need gets CATE; Gold always does', async () => {
  store.members[1].needs.long_distance = false;   // Ms Chan registers that she cannot walk long distances
  call = newCall('c1', CHAN);
  assert.equal((await verify()).verified, true);
  call = newCall('c2');
  assert.equal((await verify()).verified, true);
  const profile = await run('apply_profile', {});
  assert.equal(profile.profile.tier, 'Gold');
  assert.equal(profile.profile.passport_on_file, true);
  assert.ok(!JSON.stringify(profile).includes(store.members[0].passport.number), 'the passport number never reaches the model');
  assert.match(profile.next, /as a Gold member, and ask which service he would like today: book a flight, change a booking/);
});

/** Verified, Vancouver searched, option chosen, seat and meal kept, wheelchair as last time. */
async function upToAssistance(option = '1') {
  await verify();
  await run('find_flights', VANCOUVER);
  await run('choose_option', { option_id: option });
  await run('set_preferences', { seat_ok: true, meal_ok: true });
  await run('set_assistance', { same_as_last_trip: true });
}

test('seat: window or aisle, cabin area, or a seat number; a seat that does not exist is refused', async () => {
  await verify();
  await run('find_flights', VANCOUVER);
  await run('choose_option', { option_id: '1' });
  assert.match((await run('set_preferences', { seat_ok: false, meal_ok: true })).error, /window or aisle, front, middle or back/);
  assert.match((await run('set_preferences', { seat_ok: false, meal_ok: true, seat_number: '99Z' })).error, /not a seat on our planes/);
  assert.equal((await run('set_preferences', { seat_ok: false, meal_ok: true, seat: 'aisle', seat_area: 'back' })).confirm, 'An aisle seat near the back of the cabin and a vegetarian meal.');
  assert.equal((await run('set_preferences', { seat_ok: false, meal_ok: true, seat_number: '21 a' })).confirm, 'Seat 21A and a vegetarian meal.');
  await run('set_assistance', { same_as_last_trip: true });
  assert.match((await run('hold_booking', {})).readback, /Seat 21A, a vegetarian meal\./);
  await run('hold_booking', { caller_confirmed: true });
  assert.equal(store.orders.at(-1).seat_number, '21A');
});

test('baggage and special requests: priced by the Orders system, read back, and on the booking', async () => {
  await upToAssistance();
  assert.match((await run('set_baggage', { extra_bags: 5 })).error, /from 0 to 3/);
  const bags = await run('set_baggage', { extra_bags: 2 });
  assert.equal(bags.confirm, '2 extra checked bags, 1,000 Hong Kong dollars.');
  assert.match((await run('set_special_request', {})).error, /anything else we should arrange/);
  const request = await run('set_special_request', { request: 'It is my wife\'s 70th birthday on the flight' });
  assert.match(request.confirm, /noted that for our staff: It is my wife's 70th birthday on the flight\. I have passed it to our team\./);
  assert.match(request.next, /call hold_booking now/);
  const oxygen = await run('set_special_request', { request: 'I travel with a portable oxygen concentrator' });
  assert.match(oxygen.confirm, /needs Cathay's approval before the flight/);
  const first = await run('hold_booking', {});
  assert.match(first.readback, /2 extra checked bags, 1,000 Hong Kong dollars\. Noted for our staff: It is my wife's 70th birthday on the flight; I travel with a portable oxygen concentrator\. The total is 9,420 Hong Kong dollars/);
  await run('hold_booking', { caller_confirmed: true });
  const order = store.orders.at(-1);
  assert.deepEqual([order.extra_bags, order.extras_hkd, order.total_hkd, order.due_hkd], [2, 1000, 9420, 9420]);
  assert.equal(order.requests.length, 2);
});

test('baggage and requests are asked once but never block the hold', async () => {
  await upToAssistance();
  const first = await run('hold_booking', {});
  assert.equal(first.needs_confirmation, true);
  assert.match(first.readback, /The total is 8,420 Hong Kong dollars/);
});

/** Books option `option` for Mr Wong on call c1 and marks it paid, as after the pay page. Returns its ref. */
async function bookedAndPaid(option) {
  await upToAssistance(option);
  await run('hold_booking', {});
  const { ref } = await run('hold_booking', { caller_confirmed: true });
  setOrderStatus(ref, 'paid');
  store.paidEvents.add(ref);
  call = newCall('c2');   // a later call
  await verify();
  return ref;
}

test('change booking: new dates that cost more put the difference on the pay page; nothing changes before a yes', async () => {
  config.payment = 'page';
  const ref = await bookedAndPaid('3');   // 6,900 via Tokyo
  const found = await run('find_booking', {});
  assert.equal(found.bookings.length, 1);
  assert.match(found.say, /Vancouver, leaving Friday 19 February/);
  await run('find_flights', VANCOUVER);
  const chose = await run('choose_option', { option_id: '1' });   // tapped on the trip page, or said
  assert.match(chose.next, new RegExp(`change_booking now for booking ${ref} with option_id 1`));
  const preview = await run('change_booking', { ref, option_id: '1' });
  assert.equal(preview.needs_confirmation, true);
  assert.match(preview.readback, /New flights: leaving Friday 19 February at 11:40 am.*It costs 1,520 Hong Kong dollars more, which you pay on the payment page on your phone\. Shall I make this change\?$/);
  assert.equal(store.orders.find((o) => o.ref === ref).fare_hkd, 6900, 'nothing changed yet');
  assert.equal((await run('change_booking', { ref, option_id: '2', caller_confirmed: true })).needs_confirmation, true, 'a yes to another change is not a yes');
  await run('change_booking', { ref, option_id: '1' });
  const done = await run('change_booking', { ref, option_id: '1', caller_confirmed: true });
  assert.equal(done.status, 'held');
  assert.equal(done.due_hkd, 1520);
  const order = store.orders.find((o) => o.ref === ref);
  assert.deepEqual([order.status, order.fare_hkd, order.total_hkd, order.due_hkd, order.out.flight], ['held', 8420, 8420, 1520, 'CX0V1']);
  assert.equal(call.payRequested, 'his trip page');
  assert.equal(store.pages.get(call.pageCode).ref, ref, 'his trip page now goes to the pay page');
  assert.match(sent.sms.at(-1).body, new RegExp(`booking ${ref} has been changed\\nPay the difference of 1,520 HKD`));
  assert.ok(!store.paidEvents.has(ref), 'the difference can be paid');
});

test('change booking: a seat, meal or bag change on a paid booking; cheaper or free stays paid', async () => {
  const ref = await bookedAndPaid('1');   // 8,420
  await run('find_booking', {});
  assert.match((await run('change_booking', { ref })).error, /what he would like to change/);
  assert.match((await run('change_booking', { ref: 'ZZZZZZ', meal: 'vegan' })).error, /not one of his bookings/);
  const preview = await run('change_booking', { ref, seat_number: '12C', meal: 'vegan' });
  assert.match(preview.readback, /Seat: seat 12C\. Meal: vegan\. The price stays the same\./);
  const done = await run('change_booking', { ref, seat_number: '12C', meal: 'vegan', caller_confirmed: true });
  assert.equal(done.status, 'paid');
  const order = store.orders.find((o) => o.ref === ref);
  assert.deepEqual([order.seat_number, order.meal, order.status], ['12C', 'vegan', 'paid']);
  // a bag on a paid booking costs the fee: held again, with the fee due
  await run('find_booking', {});
  assert.match((await run('change_booking', { ref, extra_bags: 1 })).readback, /Baggage: 1 extra checked bag\. It costs 500 Hong Kong dollars more/);
  const bag = await run('change_booking', { ref, extra_bags: 1, caller_confirmed: true });
  assert.equal(bag.status, 'held');
  assert.equal(store.orders.find((o) => o.ref === ref).due_hkd, 500);
});

test('change booking: another member\'s booking, or a flight to another city, cannot be changed', async () => {
  const ref = await bookedAndPaid('1');
  call = newCall('c3', CHAN);
  store.members[1].needs.long_distance = false;
  await verify();
  assert.deepEqual((await run('find_booking', {})).bookings, []);
  assert.match((await run('change_booking', { ref, meal: 'vegan' })).error, /not one of his bookings/);
  call = newCall('c4');
  await verify();
  await run('find_booking', {});
  await run('find_flights', { to: 'Osaka', after: '2026-12-25', before: '2027-01-01' });
  assert.match((await run('change_booking', { ref, option_id: '1' })).error, /not to Vancouver/);
});

test('find_flights offers 3 options when 3 or more fit, even on a route with one flight a day', async () => {
  await verify();
  const r = await run('find_flights', { to: 'Hanoi', after: '2026-11-16', before: '2026-11-20' });
  assert.equal(r.ok, true);
  assert.equal(r.options.length, 3);
  assert.equal(new Set(r.options.map((o) => o.out.flight + o.out.dep)).size, 3, 'three different departures');
  assert.ok(r.options.every((o) => o.out.arr < o.back.dep), 'each one is back in time for the return flight');
});

test('a yes said over an unfinished read-back holds nothing; after the question it does', async () => {
  await verify();
  await run('find_flights', VANCOUVER);
  await run('choose_option', { option_id: '1' });
  await run('set_preferences', { seat_ok: true, meal_ok: true });
  await run('set_assistance', { same_as_last_trip: true });
  await run('set_baggage', { extra_bags: 0 });
  await run('set_special_request', { none: true });
  assert.equal((await run('hold_booking', {})).needs_confirmation, true);
  emit(call.id, 'cate_said', { text: 'Let me read it all back to you. Nothing is booked until you say yes.' });
  const early = await tools.runTool('hold_booking', { caller_confirmed: true }, call);   // "yes" over the read-back
  assert.equal(early.ok, false);
  assert.match(early.error, /before he heard the whole read-back/);
  assert.equal(call.ref ?? null, null, 'nothing held');
  emit(call.id, 'cate_said', { text: 'Shall I hold this booking?' });
  const held = await tools.runTool('hold_booking', { caller_confirmed: true }, call);
  assert.equal(held.status, 'held');
});

test('PROMPT=demo (optional): one yes keeps everything as last time, and the booking is checked on the trip page, not read out', { skip: !HAS_DEMO && 'no src/model/prompt_demo.js' }, async () => {
  const before = process.env.PROMPT;
  process.env.PROMPT = 'demo';
  try {
    await verify();
    const found = await run('find_flights', VANCOUVER);
    assert.match(found.next, /say only the first read_out sentence/);
    await run('text_options', {});
    const chosen = await run('choose_option', { option_id: '1' });
    assert.match(chosen.next, /"Same as last time\? Window seat, vegetarian meal, wheelchair to the gate, no extra bags\."/);
    assert.match(chosen.next, /call keep_as_last_time/);
    assert.doesNotMatch(chosen.next, /^Say:/, 'no sentence said back after each answer');
    const kept = await run('keep_as_last_time', {});
    assert.equal(kept.code, 'WCHR');
    assert.match(kept.next, /call hold_booking now/);
    const hold = await run('hold_booking', {});
    assert.equal(hold.on_trip_page, true);
    assert.match(hold.readback, /on your trip page now.*Shall I hold this booking\?$/);
    assert.equal(hold.short_readback, undefined, 'no spoken summary for the model to read out instead');
    const card = store.pages.get(call.pageCode).summary;
    assert.equal(card.out.flight, 'CX0V1');
    assert.equal(card.help, 'Wheelchair from check-in to the gate. Can manage stairs and walk to the seat.');
    assert.equal(card.extra_bags, 0);
    assert.equal(card.total_hkd, 8420);
    assert.equal((await run('hold_booking', { caller_confirmed: true })).status, 'held');
    assert.equal(store.pages.get(call.pageCode).summary, null, 'once held, the page shows the held booking instead');
  } finally {
    if (before === undefined) delete process.env.PROMPT; else process.env.PROMPT = before;
  }
});

test('exact days: "Milan on the 16th for five days" leaves on the 16th and comes back on the 21st, never the same day', async () => {
  await verify();
  const r = await run('find_flights', { to: 'Milan', depart_on: '2026-11-16', return_on: '2026-11-21' });
  assert.equal(r.ok, true);
  assert.equal(r.options[0].out.dep.slice(0, 10), '2026-11-16', 'the day he named comes first');
  assert.equal(r.options[0].back.dep.slice(0, 10), '2026-11-21', 'back on the day he named');
  assert.equal(r.options.length, 1, 'one flight on the 16th: that one is offered, not other days');
  assert.equal(r.on_day_asked, true);
  assert.match(r.next, /Then ask if that flight suits him; on a yes, call choose_option with option 1\./);
  for (const o of r.options) assert.ok(o.back.dep.slice(0, 10) > o.out.arr.slice(0, 10), `${o.out.dep}: at least one night there`);
  assert.equal((await run('find_flights', { to: 'Milan', depart_on: '2026-11-21', return_on: '2026-11-16' })).ok, false, 'back before he leaves is refused');
});

test('window search: every option has its own return flight at least one night after it lands', async () => {
  await verify();
  const r = await run('find_flights', { to: 'Milan', after: '2026-11-16', before: '2026-11-21' });
  for (const o of r.options) assert.ok(o.back.dep.slice(0, 10) > o.out.arr.slice(0, 10), `${o.out.dep} → ${o.back.dep}: no same-day return`);
});

test('exact days, every route: only flights on the day asked (up to 3), back on the day asked, at least one night; nearest days only when that day has none', async () => {
  const flights = JSON.parse(readFileSync(new URL('../data/flights.json', import.meta.url), 'utf8'));
  const fares = JSON.parse(readFileSync(new URL('../data/fares.json', import.meta.url), 'utf8'));
  const priced = new Set(fares.map((f) => `${f.flight} ${f.date}`));
  const depart = '2026-11-20';
  const ret = '2026-11-25';
  const cities = ['Tokyo', 'London', 'Sydney', 'Bangkok', 'Singapore', 'Taipei', 'Osaka', 'Seoul', 'Manila', 'Milan', 'New York', 'Paris', 'Hanoi', 'Melbourne'];
  await verify();
  let checked = 0;
  for (const city of cities) {
    const r = await run('find_flights', { to: city, depart_on: depart, return_on: ret });
    if (!r.ok) continue;   // a route with no flights near those days is told so; nothing to check here
    checked += 1;
    const code = r.options[0].out.to;
    const onDay = flights.filter((f) => f.from === 'HKG' && f.to === code && f.dep.startsWith(depart) && priced.has(`${f.flight} ${depart}`));
    if (onDay.length) {
      assert.equal(r.on_day_asked, true, city);
      assert.ok(r.options.every((o) => o.out.dep.startsWith(depart)), `${city}: only the day asked`);
      assert.ok(r.options.length >= 1 && r.options.length <= Math.min(3, onDay.length), `${city}: ${r.options.length} options, ${onDay.length} that day`);
    } else {
      assert.equal(r.on_day_asked, false, city);
      assert.match(r.next, /There is no flight on Friday 20 November/, city);
    }
    for (const o of r.options) {
      assert.ok(o.back.dep.slice(0, 10) > o.out.arr.slice(0, 10), `${city} ${o.out.dep}: at least one night`);
      assert.ok(Math.abs(Date.parse(o.back.dep.slice(0, 10)) - Date.parse(ret)) <= 2 * 864e5, `${city}: back near the day asked`);
    }
  }
  assert.ok(checked >= 10, `checked ${checked} routes`);
});

test('a code the caller never read out is not checked and costs no try', async () => {
  await run('send_code', {});
  const invented = await tools.runTool('verify_caller', { code: '123456' }, call);   // no caller_said since the code went out
  assert.equal(invented.verified, false);
  assert.match(invented.error, /has not read out a code yet/);
  assert.equal(call.verifyFails ?? 0, 0, 'not counted as a wrong try');
  assert.equal((await run('verify_caller', { code: call.sentCode })).verified, true);
});

test('exact days: a day to leave but no stay length asks "How many days will you stay?", not a list of dates', async () => {
  await verify();
  const r = await run('find_flights', { to: 'Taipei', depart_on: '2026-11-16' });
  assert.equal(r.ok, false);
  assert.match(r.error, /How many days will you stay\?/);
  assert.doesNotMatch(r.error, /We fly to/);
});

test('PROMPT=demo (optional): a quick "yes" over the hold question counts once CATE has started it; the full call keeps the strict rule', { skip: !HAS_DEMO && 'no src/model/prompt_demo.js' }, async () => {
  const before = process.env.PROMPT;
  process.env.PROMPT = 'demo';
  try {
    await verify();
    await run('find_flights', VANCOUVER);
    await run('text_options', {});
    await run('choose_option', { option_id: '1' });
    await run('keep_as_last_time', {});
    await run('hold_booking', {});
    const tooSoon = await tools.runTool('hold_booking', { caller_confirmed: true }, call);   // before CATE said a word of it
    assert.equal(tooSoon.ok, false);
    emit(call.id, 'cate_said', { text: 'Everything is on your trip page now' });            // he talks over the rest
    assert.equal((await tools.runTool('hold_booking', { caller_confirmed: true }, call)).status, 'held');
  } finally {
    if (before === undefined) delete process.env.PROMPT; else process.env.PROMPT = before;
  }
});
