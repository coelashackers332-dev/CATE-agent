import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import twilio from 'twilio';
import { WebSocket } from 'ws';
import { config } from '../src/config.js';
import { store, findOrder } from '../src/store.js';
import { bus, emit } from '../src/events.js';
import { createApp } from '../src/server.js';
import { createPayment } from '../src/payment.js';
import { createMessages } from '../src/messages.js';
import { decode, encode } from '../src/mulaw.js';

// Fixed test settings, whatever a local .env says: placeholder numbers only, no real ones.
Object.assign(config, { baseUrl: 'https://cate.test', adminSecret: 'test-admin', demoCallerNumber: '', danielPhone: '', danielEmail: '' });
const AUTH = 'test-auth-token';
const WONG = '+85200000001';
const DANIEL = '+85200000002';
const STRANGER = '+85200000009';

// Stubs for the modules other people write.
const sessions = [];
const sent = [];
const paidCalls = [];
const messages = { sendSms: async (to, body) => { sent.push({ to, body }); }, sendEmail: async () => {} };
const texts = { bookedSms: (order, profile, link) => `BOOKED ${order.ref} ${profile.name.family} ${link}` };
const realPayment = createPayment({ messages, texts, baseUrl: config.baseUrl });
const deps = {
  tools: { specs: [{ name: 'verify_caller' }], runTool: async () => ({ ok: true }) },
  startSession(args) {
    const session = { args, audio: [], notes: [], closed: 0, audioIn(pcm) { this.audio.push(pcm); }, notify(t) { this.notes.push(t); }, close() { this.closed += 1; } };
    sessions.push(session);
    return session;
  },
  renderTripPage: ({ page, order, profile }) => `TRIP ${profile.member_id} ${order?.status ?? 'options'} ${page.options.length}`,
  notFoundPage: () => '<h1>Not found</h1>',
  projectorHtml: '<html>projector</html>',
  handleMockCathay: (req, res) => { res.end('mock cathay'); return true; },
  messages,
  payment: { onPaid: (...a) => { paidCalls.push(a); return realPayment.onPaid(...a); } },
};

let server;
let base;
const sockets = [];

before(async () => {
  server = createApp(deps).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  for (const ws of sockets) ws.terminate();
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  store.reset({ log: false });
  config.twilio.authToken = AUTH;
  sessions.length = sent.length = paidCalls.length = 0;
});

const get = (path, headers) => fetch(base + path, { headers });
const post = (path, headers) => fetch(base + path, { method: 'POST', headers });
function twilioPost(path, params, signature = twilio.getExpectedTwilioSignature(AUTH, config.baseUrl + path, params), extra = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(signature && { 'X-Twilio-Signature': signature }), ...extra },
    body: new URLSearchParams(params),
  });
}
const callFrom = (from) => twilioPost('/twilio/voice', { CallSid: 'CAtest', From: from, To: '+85200000000' });
const smsFrom = (from, body) => twilioPost('/twilio/sms', { MessageSid: 'SMtest', From: from, Body: body });

async function until(check, what = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}
async function openSocket(path) {
  const ws = new WebSocket(base.replace('http', 'ws') + path);
  ws.received = [];
  ws.on('message', (raw) => ws.received.push(JSON.parse(raw)));
  sockets.push(ws);
  // A refused upgrade arrives as 'error', which events.once() would turn into a rejection.
  await new Promise((done) => { ws.on('open', done); ws.on('close', done); ws.on('error', done); });
  return ws;
}
const holdOrder = (ref = 'K7Q2XM') => {
  store.orders.push({ ref, member_id: 'DEMO-0001', status: 'held', payer: 'Daniel Wong', passenger: 'WONG TAK MING' });
  return ref;
};

test('/, unknown paths and refused admin routes give the same 404', async () => {
  const replies = await Promise.all([
    get('/'), get('/nope'), get('/v/'), get('/twilio/voice'), post('/twilio/nope'),
    get('/projector'), get('/projector?key=wrong'), post('/reset'), post('/reset', { 'x-admin-key': 'wrong' }),
    post('/dev/simulate', { 'x-admin-key': 'wrong' }), get('/events?key=test-admin'),
  ]);
  for (const r of replies) {
    assert.equal(r.status, 404, r.url);
    assert.equal(await r.text(), '<h1>Not found</h1>', r.url);
  }
});

test('/projector and /reset work with the admin key', async () => {
  const page = await get('/projector?key=test-admin');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<html>projector</html>');

  holdOrder();
  await callFrom(WONG);
  assert.ok(store.activeCall);
  const refused = await post('/reset', { 'x-admin-key': 'wrong' });
  assert.equal(refused.status, 404);
  assert.ok(findOrder('K7Q2XM'), 'a wrong key must not reset');

  const done = await post('/reset', { 'x-admin-key': 'test-admin' });
  assert.deepEqual(await done.json(), { ok: true });
  assert.equal(findOrder('K7Q2XM'), null);
  assert.equal(store.activeCall, null);
});

test('voice webhook: bad or missing signature is refused', async () => {
  const params = { CallSid: 'CAtest', From: WONG };
  for (const signature of ['bm90IGEgc2lnbmF0dXJl', null]) {
    const r = await twilioPost('/twilio/voice', params, signature);
    assert.equal(r.status, 403);
  }
  // A signature for other parameters does not carry over.
  const other = twilio.getExpectedTwilioSignature(AUTH, config.baseUrl + '/twilio/voice', { ...params, From: STRANGER });
  assert.equal((await twilioPost('/twilio/voice', params, other)).status, 403);
  assert.equal(store.activeCall, null);
});

test('voice webhook: no auth token set → unsigned requests pass only from this machine', async () => {
  config.twilio.authToken = '';
  const proxied = await twilioPost('/twilio/voice', { From: WONG }, null, { 'X-Forwarded-For': '203.0.113.7' });
  assert.equal(proxied.status, 403);
  const local = await twilioPost('/twilio/voice', { From: WONG }, null);
  assert.equal(local.status, 200);
});

test('voice webhook: known caller gets a stream with a one-time token and a call context', async () => {
  const r = await callFrom(WONG);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/xml/);
  const twiml = await r.text();
  assert.match(twiml, /<Connect><Stream url="wss:\/\/cate\.test\/twilio\/stream"><Parameter name="token" value="[\w-]{20,}"\/>/);
  assert.ok(!twiml.includes(WONG), 'the caller number stays out of the TwiML');
  assert.deepEqual(store.activeCall, {
    id: store.activeCall.id, callerId: WONG, memberId: null, token: null, verified: false, options: [],
    pageCode: null, pendingHold: null, assistance: null, ref: null, session: null,
  });
  assert.match(store.activeCall.id, /^c\d+$/);
});

test('voice webhook: one call at a time', async () => {
  await callFrom(WONG);
  const first = store.activeCall;
  const twiml = await (await callFrom(WONG)).text();
  assert.match(twiml, /<Say>.*another call.*<\/Say><Hangup\/>/);
  assert.ok(!twiml.includes('<Stream'));
  assert.equal(store.activeCall, first);
});

test('voice webhook: unknown number hears a short message and the call ends', async () => {
  const twiml = await (await callFrom(STRANGER)).text();
  assert.match(twiml, /<Say>.*not registered.*<\/Say><Hangup\/>/);
  assert.ok(!twiml.includes('<Stream'));
  assert.equal(store.activeCall, null);
});

test('call audio: token check, μ-law both ways in 20 ms frames, clear on interrupt, stop frees the line', async () => {
  const token = (await (await callFrom(WONG)).text()).match(/name="token" value="([^"]+)"/)[1];
  const call = store.activeCall;

  // A stream with the wrong token is dropped and does not start the model.
  const intruder = await openSocket('/twilio/stream');
  intruder.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZbad', customParameters: { token: 'guess' } } }));
  await once(intruder, 'close');
  assert.equal(sessions.length, 0);

  const ws = await openSocket('/twilio/stream');
  ws.send(JSON.stringify({ event: 'connected' }));
  ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZtest', customParameters: { token } } }));
  await until(() => call.session, 'the model session');
  const session = sessions[0];
  assert.equal(session.args.call, call);
  assert.equal(session.args.specs, deps.tools.specs);
  assert.equal(session.args.runTool, deps.tools.runTool);
  assert.equal(session.args.emit, emit);

  // caller → model
  const tone = Int16Array.from({ length: 160 }, (_, i) => Math.round(8000 * Math.sin(i / 5)));
  ws.send(JSON.stringify({ event: 'media', media: { payload: encode(tone).toString('base64') } }));
  await until(() => session.audio.length === 1, 'caller audio');
  assert.ok(session.audio[0] instanceof Int16Array);
  assert.deepEqual(session.audio[0], decode(encode(tone)));

  // model → caller: 400 samples = 2 full frames + the rest
  const reply = Int16Array.from({ length: 400 }, (_, i) => i * 50);
  session.args.sendAudio(reply);
  session.args.onInterrupt();
  await until(() => ws.received.length === 4, 'audio frames and clear');
  const frames = ws.received.slice(0, 3);
  assert.deepEqual(frames.map((m) => [m.event, m.streamSid, Buffer.from(m.media.payload, 'base64').length]),
    [['media', 'MZtest', 160], ['media', 'MZtest', 160], ['media', 'MZtest', 80]]);
  assert.deepEqual(Buffer.concat(frames.map((m) => Buffer.from(m.media.payload, 'base64'))), encode(reply));
  assert.deepEqual(ws.received[3], { event: 'clear', streamSid: 'MZtest' });

  // The token was used up: a second stream cannot join the call.
  const replay = await openSocket('/twilio/stream');
  replay.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZreplay', customParameters: { token } } }));
  await once(replay, 'close');
  assert.equal(sessions.length, 1);
  assert.equal(store.activeCall, call);

  ws.send(JSON.stringify({ event: 'stop' }));
  await until(() => store.activeCall === null, 'the line to be free');
  assert.equal(session.closed, 1);
  assert.equal(call.session, null);
});

test('GET /v/:code: page with privacy headers; unknown and expired codes are the same 404', async () => {
  store.pages.set('good-code', { member_id: 'DEMO-0001', options: [{ id: '1' }, { id: '2' }], ref: null, expires: Date.now() + 60_000 });
  store.pages.set('old-code', { member_id: 'DEMO-0001', options: [], ref: null, expires: new Date(Date.now() - 1000).toISOString() });

  const ok = await get('/v/good-code');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'TRIP DEMO-0001 options 2');
  for (const r of [ok, await get('/v/old-code'), await get('/v/unknown')]) {
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    if (r !== ok) {
      assert.equal(r.status, 404);
      assert.equal(await r.text(), '<h1>Not found</h1>');
    }
  }

  // The page follows the booking: once the order is paid, the same link renders from the new state.
  store.pages.get('good-code').ref = holdOrder();
  assert.equal(await (await get('/v/good-code')).text(), 'TRIP DEMO-0001 held 2');
  assert.equal((await post('/v/good-code')).status, 404, 'read-only');
});

test('SMS PAY: only a signed text from the delegate, only while held', async () => {
  const ref = holdOrder();
  assert.equal((await twilioPost('/twilio/sms', { From: DANIEL, Body: 'PAY' }, 'bad')).status, 403);
  for (const [from, body] of [[STRANGER, 'PAY'], [WONG, 'PAY'], [DANIEL, 'PAY NOW'], [DANIEL, 'hello']]) {
    const r = await smsFrom(from, body);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<Response\/>$/);
  }
  assert.deepEqual(paidCalls, []);
  assert.equal(findOrder(ref).status, 'held');

  const r = await smsFrom(DANIEL, '  pay \n');
  assert.match(await r.text(), /<Response\/>$/);
  assert.deepEqual(paidCalls, [[ref, 'sms']]);
  assert.equal(findOrder(ref).status, 'paid');

  await smsFrom(DANIEL, 'PAY');   // nothing is held any more
  assert.equal(paidCalls.length, 1);
});

test('onPaid twice changes state once: one state event, one text 2, one notify', async () => {
  const ref = holdOrder();
  store.pages.set('trip-code', { member_id: 'DEMO-0001', options: [], ref, expires: Date.now() + 60_000 });
  const notes = [];
  store.activeCall = { id: 'c-test', session: { notify: (t) => notes.push(t) } };
  const events = [];
  const listen = (ev) => events.push(ev);
  bus.on('event', listen);
  try {
    assert.equal(await realPayment.onPaid(ref, 'sms'), true);
    assert.equal(await realPayment.onPaid(ref, 'sms'), false);
    assert.equal(await realPayment.onPaid('NOSUCH', 'sms'), false);
  } finally {
    bus.off('event', listen);
  }
  assert.equal(findOrder(ref).status, 'paid');
  assert.ok(store.paidEvents.has(ref));
  assert.deepEqual(events.map((e) => e.kind), ['state', 'system']);
  assert.deepEqual(events[0], { t: events[0].t, call_id: null, kind: 'state', ref, status: 'paid' });
  assert.equal(events[1].system, 'Payment');
  assert.equal(events[1].call_id, 'c-test');
  assert.ok(!JSON.stringify(events).includes('+852'), 'events never carry phone numbers');
  assert.deepEqual(sent, [{ to: WONG, body: 'BOOKED K7Q2XM WONG https://cate.test/v/trip-code' }]);
  assert.deepEqual(notes, ['Daniel has paid for booking K7Q2XM']);

  // A page that text_options made but nobody linked to the hold gets linked when the booking is paid.
  holdOrder('B2NEXT');
  store.pages.set('loose-code', { member_id: 'DEMO-0001', options: [], ref: null, expires: Date.now() + 60_000 });
  await realPayment.onPaid('B2NEXT', 'sms');
  assert.equal(store.pages.get('loose-code').ref, 'B2NEXT');
  assert.match(sent[1].body, /v\/loose-code$/);
});

test('WS /events: admin key needed; replays recent events, then streams new ones', async () => {
  const refused = await openSocket('/events?key=wrong');
  assert.notEqual(refused.readyState, WebSocket.OPEN);

  for (let i = 0; i < 250; i++) emit('c9', 'cate_said', { text: `line ${i}` });
  const ws = await openSocket('/events?key=test-admin');
  await until(() => ws.received.length === 200, 'the replay');
  assert.equal(ws.received[0].text, 'line 50');
  emit('c9', 'caller_said', { text: 'hello' });
  await until(() => ws.received.length === 201, 'a live event');
  assert.deepEqual(ws.received[200], { t: ws.received[200].t, call_id: 'c9', kind: 'caller_said', text: 'hello' });

  // Reset empties the replay: a projector that connects afterwards starts from the reset.
  await post('/reset', { 'x-admin-key': 'test-admin' });
  const late = await openSocket('/events?key=test-admin');
  await until(() => late.received.length === 1, 'the reset event');
  assert.equal(late.received[0].action, 'reset');
});

test('POST /dev/simulate starts a call for DEMO-0001 without a phone', async () => {
  const r = await post('/dev/simulate', { 'x-admin-key': 'test-admin' });
  assert.equal(r.status, 200);
  const call = store.activeCall;
  assert.deepEqual(await r.json(), { ok: true, call_id: call.id });
  assert.equal(call.callerId, WONG);
  assert.equal(call.session, sessions[0]);
  assert.equal(sessions[0].args.call, call);
  sessions[0].args.sendAudio(new Int16Array(160));   // goes nowhere, must not throw
  sessions[0].args.onInterrupt();

  assert.equal((await post('/dev/simulate', { 'x-admin-key': 'test-admin' })).status, 409);
  assert.match(await (await callFrom(WONG)).text(), /another call/, 'a phone call during a simulated one is busy');
  await post('/reset', { 'x-admin-key': 'test-admin' });
  assert.equal(sessions[0].closed, 1);
});

test('/mock-cathay answers this machine only', async () => {
  assert.equal(await (await get('/mock-cathay/members')).text(), 'mock cathay');
  const outside = await get('/mock-cathay/members', { 'X-Forwarded-For': '203.0.113.7' });
  assert.equal(outside.status, 404);
});

test('messages: log mode masks the number; live email says it is not set up', async () => {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const m = createMessages({ mode: 'log' });
    await m.sendSms(WONG, 'Cathay CATE: booked.');
    await m.sendEmail('daniel@example.com', 'Pay for a flight', '<p>hi</p>', 'hi');
  } finally {
    console.log = log;
  }
  assert.match(lines[0], /^\[SMS\] to \*\*\*0001\nCathay CATE: booked\./);
  assert.match(lines[1], /^\[EMAIL\] to d\*\*\*@example\.com \| Pay for a flight\nhi/);
  assert.ok(!lines.join('').includes(WONG) && !lines.join('').includes('daniel@'));
  await assert.rejects(createMessages({ mode: 'live' }).sendEmail('daniel@example.com', 's', '<p>h</p>', 'h'), /not set up yet/);
});
