import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { config } from '../src/config.js';
import { store, findOrder } from '../src/store.js';
import { bus, emit } from '../src/events.js';
import { createApp } from '../src/server.js';
import { createPayment } from '../src/payment.js';
import { createMessages } from '../src/messages.js';

// Fixed test settings, whatever a local .env says: placeholder numbers only, no real ones.
Object.assign(config, { baseUrl: 'https://cate.test', adminSecret: 'test-admin', demoCallerNumber: '', demoCallerEmail: '', danielPhone: '', danielEmail: '' });
const WONG = '+85200000001';

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
  bridgeHtml: '<html>bridge</html>',
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
  sessions.length = sent.length = paidCalls.length = 0;
});

const get = (path, headers) => fetch(base + path, { headers });
const post = (path, headers) => fetch(base + path, { method: 'POST', headers });

async function until(check, what = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}
async function openSocket(path, headers) {
  const ws = new WebSocket(base.replace('http', 'ws') + path, { headers });
  ws.received = [];
  // Text frames are JSON events; binary frames (call audio) stay Buffers.
  ws.on('message', (raw, isBinary) => ws.received.push(isBinary ? raw : JSON.parse(raw)));
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
    get('/'), get('/nope'), get('/v/'), get('/local/stream'), post('/dev/pay', { 'x-admin-key': 'wrong' }),
    get('/projector'), get('/projector?key=wrong'), get('/bridge'), get('/bridge?key=wrong'), post('/reset'), post('/reset', { 'x-admin-key': 'wrong' }),
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
  await post('/dev/simulate', { 'x-admin-key': 'test-admin' });
  assert.ok(store.activeCall);
  const refused = await post('/reset', { 'x-admin-key': 'wrong' });
  assert.equal(refused.status, 404);
  assert.ok(findOrder('K7Q2XM'), 'a wrong key must not reset');

  const done = await post('/reset', { 'x-admin-key': 'test-admin' });
  assert.deepEqual(await done.json(), { ok: true });
  assert.equal(findOrder('K7Q2XM'), null);
  assert.equal(store.activeCall, null);
});

test('/bridge: the bridge page, on this machine with the admin key only', async () => {
  const page = await get('/bridge?key=test-admin');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<html>bridge</html>');
  // Through a tunnel or proxy (X-Forwarded-For) even the right key is refused.
  const proxied = await get('/bridge?key=test-admin', { 'X-Forwarded-For': '203.0.113.7' });
  assert.equal(proxied.status, 404);
});

test('local line: only this machine with the admin key may connect', async () => {
  for (const path of ['/local/stream', '/local/stream?key=wrong']) {
    const ws = await openSocket(path);
    assert.notEqual(ws.readyState, WebSocket.OPEN, path);
  }
  // Through a tunnel or proxy (X-Forwarded-For) even the right key is refused.
  const proxied = await openSocket('/local/stream?key=test-admin', { 'X-Forwarded-For': '203.0.113.7' });
  assert.notEqual(proxied.readyState, WebSocket.OPEN);
  assert.equal(sessions.length, 0);
});

test('local line: start makes a call for DEMO-0001; PCM16 both ways as binary frames; clear on interrupt; close frees the line', async () => {
  const ws = await openSocket('/local/stream?key=test-admin');
  ws.send(JSON.stringify({ event: 'start' }));
  await until(() => store.activeCall?.session, 'the model session');
  const call = store.activeCall;
  const session = sessions[0];
  assert.deepEqual({ ...call, session: null }, {
    id: call.id, callerId: WONG, memberId: null, token: null, verified: false, options: [],
    pageCode: null, pendingHold: null, assistance: null, ref: null, session: null,
  });
  assert.equal(session.args.call, call);
  assert.equal(session.args.specs, deps.tools.specs);
  assert.equal(session.args.runTool, deps.tools.runTool);
  assert.equal(session.args.emit, emit);

  // caller → model: 20 ms of 8 kHz PCM16 little-endian, plus a stray odd byte that is dropped
  const tone = Int16Array.from({ length: 160 }, (_, i) => Math.round(8000 * Math.sin(i / 5)));
  const bytes = Buffer.alloc(321);
  tone.forEach((s, i) => bytes.writeInt16LE(s, i * 2));
  ws.send(bytes);
  await until(() => session.audio.length === 1, 'caller audio');
  assert.ok(session.audio[0] instanceof Int16Array);
  assert.deepEqual(session.audio[0], tone);

  // model → caller, then a barge-in
  const reply = Int16Array.from({ length: 400 }, (_, i) => i * 50 - 10_000);
  session.args.sendAudio(reply);
  session.args.onInterrupt();
  await until(() => ws.received.length === 2, 'audio and clear');
  const out = ws.received[0];
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(Int16Array.from({ length: out.length / 2 }, (_, i) => out.readInt16LE(i * 2)), reply);
  assert.deepEqual(ws.received[1], { event: 'clear' });

  // One call at a time: a second bridge hears busy and is closed; the first call is untouched.
  const second = await openSocket('/local/stream?key=test-admin');
  second.send(JSON.stringify({ event: 'start' }));
  await once(second, 'close');
  assert.deepEqual(second.received, [{ event: 'busy' }]);
  assert.equal(store.activeCall, call);
  assert.equal(sessions.length, 1);

  ws.close();
  await until(() => store.activeCall === null, 'the line to be free');
  assert.equal(session.closed, 1);
  assert.equal(call.session, null);
});

test('local line: /reset hangs up the bridge', async () => {
  const ws = await openSocket('/local/stream?key=test-admin');
  ws.send(JSON.stringify({ event: 'start' }));
  await until(() => store.activeCall?.session, 'the model session');
  await post('/reset', { 'x-admin-key': 'test-admin' });
  await until(() => ws.readyState === WebSocket.CLOSED, 'the bridge socket to close');
  assert.equal(sessions[0].closed, 1);
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

test('POST /v/:code: answer buttons run the call\'s own tools only while that call is live, verified and nothing is held', async () => {
  store.pages.set('live-code', { member_id: 'DEMO-0001', options: [{ id: '1' }, { id: '2' }], ref: null, expires: Date.now() + 60_000 });
  const ran = [];
  const notes = [];
  const realRun = deps.tools.runTool;
  deps.tools.runTool = async (name, args) => { ran.push([name, args]); return { ok: true, confirm: `${name} done.` }; };
  const form = (path, body) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  try {
    // no live call: read-only
    assert.equal((await form('/v/live-code', 'option=1')).status, 404);
    store.activeCall = { id: 'c-live', pageCode: 'live-code', verified: true, ref: null, options: [{ id: '1' }, { id: '2' }], session: { notify: (t) => notes.push(t) } };
    const chose = await form('/v/live-code', 'option=2');
    assert.equal(chose.status, 303);
    assert.equal(chose.headers.get('location'), '/v/live-code');
    await form('/v/live-code', 'payer=family');
    await form('/v/live-code', 'option=9');          // not one of his options: ignored
    await form('/v/live-code', 'payer=someone');     // not an answer: ignored
    assert.deepEqual(ran, [['choose_option', { option_id: '2' }], ['set_payer', { payer: 'family' }]]);
    assert.equal(notes.length, 2);
    assert.match(notes[0], /chose flight 2 with the button on his trip page/);
    // another page's code, an unverified call, or a held booking: read-only again
    assert.equal((await form('/v/good-code', 'option=1')).status, 404);
    store.activeCall.verified = false;
    assert.equal((await form('/v/live-code', 'option=1')).status, 404);
    store.activeCall.verified = true;
    store.activeCall.ref = 'K7Q2XM';
    assert.equal((await form('/v/live-code', 'option=1')).status, 404);
    store.activeCall.ref = null;
    assert.equal((await form('/v/live-code', 'x='.padEnd(3000, 'a'))).status, 413);
    assert.equal(ran.length, 2);
  } finally {
    deps.tools.runTool = realRun;
    store.activeCall = null;
  }
});

test('POST /dev/pay: admin key only; pays the held booking once; nothing held is a 409', async () => {
  assert.equal((await post('/dev/pay', { 'x-admin-key': 'test-admin' })).status, 409);
  const ref = holdOrder();
  assert.equal((await post('/dev/pay', { 'x-admin-key': 'wrong' })).status, 404);
  assert.equal(findOrder(ref).status, 'held');

  const r = await post('/dev/pay', { 'x-admin-key': 'test-admin' });
  assert.deepEqual(await r.json(), { ok: true, ref });
  assert.deepEqual(paidCalls, [[ref, 'demo']]);
  assert.equal(findOrder(ref).status, 'paid');
  assert.equal((await post('/dev/pay', { 'x-admin-key': 'test-admin' })).status, 409, 'nothing is held any more');
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
  const bridge = await openSocket('/local/stream?key=test-admin');
  bridge.send(JSON.stringify({ event: 'start' }));
  await once(bridge, 'close');
  assert.deepEqual(bridge.received, [{ event: 'busy' }], 'a phone call during a simulated one is busy');
  await post('/reset', { 'x-admin-key': 'test-admin' });
  assert.equal(sessions[0].closed, 1);
});

test('/mock-cathay answers this machine only', async () => {
  assert.equal(await (await get('/mock-cathay/members')).text(), 'mock cathay');
  const outside = await get('/mock-cathay/members', { 'X-Forwarded-For': '203.0.113.7' });
  assert.equal(outside.status, 404);
});

test('messages: log mode masks the number; live email needs a mail login', async () => {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const m = createMessages({ mode: 'log', texts: 'sms' });   // fixed, whatever a local .env says
    await m.sendSms(WONG, 'Cathay CATE: booked.');
    await m.sendEmail('daniel@example.com', 'Pay for a flight', '<p>hi</p>', 'hi');
  } finally {
    console.log = log;
  }
  assert.match(lines[0], /^\[SMS\] to \*\*\*0001\nCathay CATE: booked\./);
  assert.match(lines[1], /^\[EMAIL\] to d\*\*\*@example\.com \| Pay for a flight\nhi/);
  assert.ok(!lines.join('').includes(WONG) && !lines.join('').includes('daniel@'));
  // An empty login on purpose: a real one in a local .env must never be used by a test.
  await assert.rejects(createMessages({ mode: 'live', texts: 'sms', email: { user: '', pass: '' } }).sendEmail('daniel@example.com', 's', '<p>h</p>', 'h'), /EMAIL_USER/);
});
