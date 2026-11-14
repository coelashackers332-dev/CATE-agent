// End to end, real modules, no phone: the scripted model plays the golden path, Daniel replies PAY,
// and the trip page turns into the confirmation with the needs card.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SCRIPT_STEP_MS = '0';
const { config } = await import('../src/config.js');
// Fixed test settings, whatever a local .env says: nothing is really sent, the scripted model plays the call,
// and the unsigned PAY below is accepted (with a Twilio token set, only signed requests are).
Object.assign(config, { messages: 'log', payment: 'sms', model: 'scripted' });
config.twilio.authToken = '';
const { store, findOrder } = await import('../src/store.js');
const { bus } = await import('../src/events.js');
const { wireApp } = await import('../src/server.js');

const until = async (check, what) => {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail(`timed out waiting for ${what}`);
};

test('golden path: scripted call, PAY reply, confirmed trip page', async () => {
  store.reset({ log: false });
  const events = [];
  const onEvent = (ev) => events.push(ev);
  bus.on('event', onEvent);
  const app = await wireApp();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const admin = { 'x-admin-key': config.adminSecret };
  try {
    const sim = await fetch(`${base}/dev/simulate`, { method: 'POST', headers: admin });
    assert.equal(sim.status, 200);

    await until(() => store.activeCall?.payRequested, 'the pay request');
    const order = findOrder('K7Q2XM');
    assert.equal(order.status, 'held');
    assert.deepEqual(order.ssr, ['WCHR']);
    assert.equal(order.passenger, 'WONG TAK MING');
    assert.equal(order.fare_hkd, 8420);

    const code = store.activeCall.pageCode;
    const held = await (await fetch(`${base}/v/${code}`)).text();
    assert.match(held, /8,420/);
    assert.doesNotMatch(held, /K7Q2XM[\s\S]*show this card/i);

    // A PAY from a stranger changes nothing; a PAY from Daniel's number on file pays.
    const pay = (from) => fetch(`${base}/twilio/sms`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, Body: 'pay' }),
    });
    await pay('+85299999999');
    assert.equal(order.status, 'held');
    await pay(store.members[0].delegates[0].phone);
    assert.equal(order.status, 'paid');
    await until(() => events.some((e) => e.kind === 'cate_said' && /has paid/.test(e.text)), 'CATE saying Daniel paid');

    const paid = await (await fetch(`${base}/v/${code}`)).text();
    assert.match(paid, /K7Q2XM/);
    assert.match(paid, /WCHR/);
    assert.match(paid, /show this card/i);

    // Tools ran in the order the rules require.
    const tools = events.filter((e) => e.kind === 'tool_call').map((e) => e.name);
    assert.deepEqual(tools, ['verify_caller', 'apply_profile', 'find_flights', 'text_options',
      'set_assistance', 'hold_booking', 'hold_booking', 'send_pay_link']);
    // No phone number or email address ever reaches the projector.
    const feed = JSON.stringify(events);
    assert.doesNotMatch(feed, /\+852\d{8}/);
    assert.doesNotMatch(feed, /@example\.com/);
  } finally {
    bus.off('event', onEvent);
    await fetch(`${base}/reset`, { method: 'POST', headers: admin });
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  }
});
