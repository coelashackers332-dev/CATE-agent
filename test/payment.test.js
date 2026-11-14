// The pay page, GET and POST /pay/<trip page code>: a demo checkout (no money moves) that pays through onPaid.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { config } from '../src/config.js';
import { store, findOrder } from '../src/store.js';
import { bus } from '../src/events.js';
import { createApp } from '../src/server.js';
import { createPayment } from '../src/payment.js';
import { METHODS, BACK_AFTER_S } from '../src/screens/pay.js';

Object.assign(config, { baseUrl: 'https://cate.test', adminSecret: 'test-admin', demoCallerNumber: '', danielPhone: '', danielEmail: '' });
const CODE = 'pagecode-for-tests-0123456789';

const steps = [];   // what happened after a payment, in order: the call told, text 2 sent
const payment = createPayment({
  messages: { sendSms: async (to, body) => { steps.push({ step: 'text 2', to, body }); }, sendEmail: async () => {} },
  texts: { bookedSms: (order) => `BOOKED ${order.ref}` },
  baseUrl: config.baseUrl,
});

const events = [];
const onEvent = (ev) => events.push(ev);
let server;
let base;
before(async () => {
  bus.on('event', onEvent);
  server = createApp({
    tools: { specs: [], runTool: async () => ({ ok: true }) },
    startSession: () => ({ audioIn() {}, notify() {}, close() {} }),
    renderTripPage: () => 'TRIP', notFoundPage: () => '<h1>Not found</h1>', projectorHtml: '',
    handleMockCathay: () => false, messages: {}, payment,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  bus.off('event', onEvent);
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  store.reset({ log: false });
  steps.length = 0;
  events.length = 0;
});

/** A booking behind a trip page, as hold_booking leaves it. */
function booking({ status = 'held', payer = 'Daniel Wong', passenger = 'WONG TAK MING', expires = null } = {}) {
  store.orders.push({
    ref: 'K7Q2XM', member_id: 'DEMO-0001', status, payer, passenger, fare_hkd: 9350,
    out: { flight: 'CX888', from: 'HKG', to: 'YVR', city: 'Vancouver', dep: '2026-11-21T00:15', arr: '2026-11-20T20:35' },
    back: { flight: 'CX889', from: 'YVR', to: 'HKG', city: 'Hong Kong', dep: '2026-11-29T01:40', arr: '2026-11-30T06:00' },
  });
  store.pages.set(CODE, { member_id: 'DEMO-0001', options: [], ref: 'K7Q2XM', expires });
}
const open = (code = CODE) => fetch(`${base}/pay/${code}`, { redirect: 'manual' });
const pay = (method, code = CODE) => fetch(`${base}/pay/${code}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: method == null ? '' : new URLSearchParams({ method }).toString(),
});
/** The page as a reader sees it: the one entity the pages use for apostrophes, decoded. */
const read = async (res) => (await res.text()).replace(/&#39;/g, "'");
const paidLines = () => events.filter((e) => e.kind === 'system' && e.system === 'Payment' && e.action === 'paid');
async function until(check, what) {
  for (const end = Date.now() + 2000; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (check()) return;
  assert.fail(`timed out waiting for ${what}`);
}

test('a held booking\'s pay link shows only the ways to pay and one Pay button, and asks for nothing', async () => {
  booking();
  const res = await open();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  const page = await read(res);
  assert.ok(nonce && page.includes(`<script nonce="${nonce}">`), 'the page script carries this response\'s nonce');

  assert.match(page, /<title>Choose how to pay<\/title>/);
  assert.match(page, /<h1>Choose how to pay<\/h1>/);
  assert.match(page, /<button class="pay" type="submit">Pay HKD 9,350<\/button>/);
  for (const m of METHODS) assert.ok(page.includes(`value="${m.id}"`), `offers ${m.label}`);
  assert.doesNotMatch(page.replace(/nonce="[^"]*"/g, ''), /Vancouver|K7Q2XM|Wong|Daniel|Held for you|Waiting for/i, 'only the ways to pay: no trip, booking or names');
  assert.doesNotMatch(page, /type="(text|number|tel|email|password)"|autocomplete="cc-/, 'no card or personal fields');
  assert.doesNotMatch(page, /http-equiv="refresh"/, 'the pay page stays until the payer taps Pay');
  assert.equal(findOrder('K7Q2XM').status, 'held', 'opening the page pays nothing');
});

test('the pay link is Not found for unknown and expired codes, bookings not held yet or cancelled, and other methods', async () => {
  assert.equal((await open('no-such-code')).status, 404);
  assert.equal((await pay('card', 'no-such-code')).status, 404);

  store.pages.set(CODE, { member_id: 'DEMO-0001', options: [], ref: null, expires: null });
  assert.equal((await open()).status, 404, 'a trip page with no booking held yet');

  store.reset({ log: false });
  booking({ expires: '2020-01-01' });
  assert.equal((await open()).status, 404, 'an expired page');

  store.reset({ log: false });
  booking({ status: 'cancelled' });
  assert.equal((await open()).status, 404, 'a cancelled booking');

  store.reset({ log: false });
  booking();
  for (const method of ['PUT', 'DELETE']) assert.equal((await fetch(`${base}/pay/${CODE}`, { method })).status, 404, method);
  assert.equal(findOrder('K7Q2XM').status, 'held');
});

test('paying marks the booking paid once: the call hears it, then text 2; the page says so, then goes back to the trip', async () => {
  booking();
  store.activeCall = { id: 'call-1', session: { notify: (msg) => steps.push({ step: 'call told', msg }) } };

  const res = await pay('apple-pay');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/pay/${CODE}`, 'back to the same address, so a reload pays nothing');
  assert.equal(findOrder('K7Q2XM').status, 'paid');
  assert.equal(findOrder('K7Q2XM').paid_with, 'Apple Pay');
  await until(() => steps.length === 2, 'text 2');
  assert.deepEqual(steps.map((s) => s.step), ['call told', 'text 2']);
  assert.equal(steps[0].msg, 'Daniel has paid for booking K7Q2XM');
  assert.equal(steps[1].body, 'BOOKED K7Q2XM');
  assert.deepEqual(paidLines().map((e) => [e.call_id, e.summary]), [['call-1', '✓ Daniel paid for K7Q2XM (Apple Pay)']]);

  const done = await open();
  assert.equal(done.status, 200);
  const page = await read(done);
  assert.match(page, /<h1>Payment successful<\/h1>/);
  assert.match(page, /<p class="lede">HKD 9,350 paid with Apple Pay\.<\/p>/);
  assert.ok(page.includes(`<b>Thank you, Daniel.</b>Going back to the trip page in ${BACK_AFTER_S} seconds.`));
  assert.ok(page.includes(`<meta http-equiv="refresh" content="${BACK_AFTER_S};url=/v/${CODE}">`), 'goes back to the trip page by itself');
  assert.ok(page.includes(`href="/v/${CODE}"`), 'and has a button for it');

  // Another tap, even with another method, changes nothing.
  assert.equal((await pay('card')).status, 303);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(steps.length, 2);
  assert.equal(paidLines().length, 1);
  assert.equal(findOrder('K7Q2XM').paid_with, 'Apple Pay');
});

test('without a valid method nothing is paid, and the page asks again', async () => {
  booking();
  for (const method of [null, '', 'bitcoin', 'Apple Pay']) {
    const res = await pay(method);
    assert.equal(res.status, 400, `method ${JSON.stringify(method)}`);
    assert.match(await read(res), /Choose how to pay first\./);
  }
  assert.equal(findOrder('K7Q2XM').status, 'held');
  assert.equal(steps.length, 0);
  assert.equal(paidLines().length, 0);
});

test('an oversized form is refused and pays nothing', async () => {
  booking();
  const res = await fetch(`${base}/pay/${CODE}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `method=card&pad=${'a'.repeat(3000)}`,
  });
  assert.equal(res.status, 413);
  assert.equal(findOrder('K7Q2XM').status, 'held');
});

test('a traveller paying for himself sees the same page, and is thanked without a name', async () => {
  booking({ payer: 'Wong Tak Ming' });
  assert.match(await read(await open()), /<h1>Choose how to pay<\/h1>/);
  await pay('octopus');
  const done = await read(await open());
  assert.match(done, /HKD 9,350 paid with Octopus\./);
  assert.match(done, /<b>Thank you\.<\/b>/);
  assert.doesNotMatch(done, /Thank you, /);
});

test('a name reaches the page as text, never as HTML', async () => {
  booking({ payer: '<b>Mallory</b>' });
  await pay('card');
  const page = await (await open()).text();
  assert.ok(!page.includes('<b>Mallory'), 'no raw HTML from a name');
  assert.ok(page.includes('Thank you, &lt;b&gt;Mallory&lt;/b&gt;.'), 'shown escaped instead');
});
