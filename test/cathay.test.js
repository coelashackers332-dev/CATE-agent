// The adapter (src/cathay.js) against the mock Cathay systems, over real HTTP on a throwaway port.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { store } from '../src/store.js';
import { bus } from '../src/events.js';
import { config } from '../src/config.js';
import { createCathay } from '../src/cathay.js';
import { handleMockCathay } from '../src/mock-cathay/routes.js';
import { serviceKey } from '../src/mock-cathay/key.js';

let server, base, cathay, events;
const record = (ev) => events.push(ev);

before(async () => {
  server = createServer((req, res) => {
    if (!handleMockCathay(req, res)) { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  store.reset({ log: false });
  events = [];
  bus.on('event', record);
  cathay = createCathay({ base, callId: 't1' });
});
afterEach(() => bus.off('event', record));

const wong = () => store.members[0];
const verified = async () => (await cathay.checkVerification('DEMO-0001', 'Osaka, last May')).token;
const vancouverOrder = async () => {
  const { out, back } = await cathay.searchFlights({ from: 'HKG', to: 'YVR', after: '2027-02-06', before: '2027-04-05' });
  const seg = (f) => ({ flight: f.flight, from: f.from, to: f.to, city: 'x', dep: f.dep, arr: f.arr, stops: f.stops });
  return { option_id: '1', out: seg(out[0]), back: seg(back[0]), fare_hkd: out[0].return_fare_hkd, seat: 'window', meal: 'vegetarian', ssr: ['WCHR', 'BOGUS'], payer: 'Daniel Wong', passenger: 'WONG TAK MING' };
};

test('lookup by phone returns the member id only', async () => {
  assert.deepEqual(await cathay.findMemberByPhone(wong().phone), { member_id: 'DEMO-0001' });
  assert.equal(await cathay.findMemberByPhone('+85299999999'), null);
  assert.equal(await cathay.findMemberByPhone(''), null);
});

test('verification passes on the city of the latest flown trip, and creates a session token', async () => {
  const pass = await cathay.checkVerification('DEMO-0001', 'Osaka, last May');
  assert.equal(pass.ok, true);
  assert.deepEqual(store.sessions.get(pass.token), { member_id: 'DEMO-0001', call_id: 't1' });
  assert.equal((await cathay.checkVerification('DEMO-0001', 'i think it was OSAKA')).ok, true);
});

test('verification fails on a wrong city, a wrong month or an unknown member, with no token', async () => {
  for (const [member, answer] of [['DEMO-0001', 'Tokyo'], ['DEMO-0001', 'Osaka in June'], ['DEMO-0001', ''], ['NOPE', 'Osaka']]) {
    assert.deepEqual(await cathay.checkVerification(member, answer), { ok: false }, answer);
  }
  assert.equal(store.sessions.size, 0);
});

test('profile, history, payer and hold are refused without a valid token (401)', async () => {
  await assert.rejects(cathay.getProfile('not-a-token'), /401/);
  await assert.rejects(cathay.getTripHistory(null), /401/);
  await assert.rejects(cathay.getDelegate('not-a-token'), /401/);
  await assert.rejects(cathay.holdOrder('not-a-token', {}), /401/);
  const raw = await fetch(`${base}/mock-cathay/membership/members/DEMO-0001`, { headers: { 'x-service-key': serviceKey } });
  assert.equal(raw.status, 401);
  // a valid token opens only its own member
  const other = await fetch(`${base}/mock-cathay/membership/members/DEMO-0002`, { headers: { 'x-service-key': serviceKey, authorization: `Bearer ${await verified()}` } });
  assert.equal(other.status, 401);
});

test('without the service key the mock is not there at all', async () => {
  const res = await fetch(`${base}/mock-cathay/membership/lookup?phone=${encodeURIComponent(wong().phone)}`);
  assert.equal(res.status, 404);
});

test('the profile is the model-safe shape: no phone, email or delegate contacts', async () => {
  const profile = await cathay.getProfile(await verified());
  assert.deepEqual(profile, {
    name: 'WONG TAK MING', language: 'en', speech: { pace: 'slow' },
    prefs: { seat: 'window', meal: 'vegetarian', bags: 1, earliest_departure: '09:00' },
    needs: { walk_in_cabin: true, stairs: true, long_distance: false },
    has_delegate: true,
  });
  const text = JSON.stringify(profile);
  for (const secret of [wong().phone, wong().email, wong().delegates[0].phone, wong().delegates[0].email, 'Daniel']) {
    assert.ok(!text.includes(secret), secret);
  }
});

test('trip history gives the last trips, newest first', async () => {
  assert.deepEqual(await cathay.getTripHistory(await verified()), [{ to: 'Osaka', month: '2026-05', status: 'flown', ssr: ['WCHR'] }]);
});

test('the family payer comes back only with a token', async () => {
  const delegate = await cathay.getDelegate(await verified());
  assert.deepEqual(delegate, { name: 'Daniel Wong', relation: 'son', phone: wong().delegates[0].phone, email: wong().delegates[0].email });
});

test('schedule search returns seeded flights with fares, inside the dates', async () => {
  const { out, back } = await cathay.searchFlights({ from: 'HKG', to: 'YVR', after: '2027-02-06', before: '2027-04-05' });
  assert.equal(out.length, 5);
  assert.deepEqual(back.map((f) => f.flight).sort(), ['CX0V2', 'CX0V4']);
  assert.equal(out.find((f) => f.flight === 'CX0V3').return_fare_hkd, 7960);
  const late = await cathay.searchFlights({ from: 'HKG', to: 'YVR', after: '2027-02-19', before: '2027-04-05' });
  assert.deepEqual(late.out.map((f) => f.dep), ['2027-02-20T11:40']);
  assert.deepEqual(await cathay.searchFlights({ from: 'HKG', to: 'KIX', after: '2027-02-06', before: '2027-04-05' }), { out: [], back: [] });
});

test('hold adds an order for the token\'s member; the first reference is K7Q2XM', { skip: !config.demoMode && 'DEMO_MODE is off' }, async () => {
  const token = await verified();
  const created = await cathay.holdOrder(token, { ...(await vancouverOrder()), member_id: 'SOMEONE-ELSE', status: 'paid' });
  assert.equal(created.ref, 'K7Q2XM');
  assert.equal(store.orders.length, 2);
  const stored = store.orders.at(-1);
  assert.equal(stored.member_id, 'DEMO-0001');
  assert.equal(stored.status, 'held');
  assert.deepEqual(stored.ssr, ['WCHR']);
  assert.equal(stored.out.flight, 'CX0V1');
  // the next call sees it in the history
  assert.equal((await cathay.getTripHistory(token))[0].status, 'held');
});

test('hold refuses a flight that is not in the schedule', async () => {
  const order = await vancouverOrder();
  order.out = { ...order.out, flight: 'CX9999' };
  await assert.rejects(cathay.holdOrder(await verified(), order), /422/);
  assert.equal(store.orders.length, 1);
});

test('every adapter call emits exactly one system event, with no phone number or email in it', async () => {
  const token = await verified();
  await cathay.findMemberByPhone(wong().phone);
  await cathay.getProfile(token);
  await cathay.getDelegate(token);
  await cathay.getTripHistory(token);
  await cathay.holdOrder(token, await vancouverOrder());   // + 1 search inside vancouverOrder
  await cathay.getProfile('bad').catch(() => {});
  assert.equal(events.length, 8);
  assert.ok(events.every((e) => e.kind === 'system' && e.call_id === 't1' && typeof e.summary === 'string'));
  assert.deepEqual(events.map((e) => e.system), ['Membership', 'Membership', 'Membership', 'Membership', 'Orders', 'Schedule', 'Orders', 'Membership']);
  assert.equal(events[1].summary, '✓ member found (DEMO-0001)');
  assert.equal(events[4].summary, 'HKG→KIX May 2026 · WCHR');
  assert.equal(events.at(-1).ok, false);
  const text = JSON.stringify(events);
  for (const secret of [wong().phone, wong().email, wong().delegates[0].phone, wong().delegates[0].email]) {
    assert.ok(!text.includes(secret), secret);
  }
});
