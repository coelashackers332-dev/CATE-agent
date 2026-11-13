import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderTripPage, notFoundPage } from '../src/screens/trip.js';
import { optionsSms, bookedSms, payRequestSms } from '../src/screens/texts.js';
import { payEmail } from '../src/screens/emails.js';

// The full member record, private fields included: the page must not print them even when handed them.
const member = JSON.parse(readFileSync(new URL('../data/membership.json', import.meta.url), 'utf8'))[0];
const daniel = member.delegates[0];
const PRIVATE = [member.phone, member.email, member.member_id, daniel.phone, daniel.email];

const seg = (flight, from, to, city, dep, arr, stops = []) => ({ flight, from, to, city, dep, arr, stops });
const back = seg('CX0V2', 'YVR', 'HKG', 'Hong Kong', '2027-03-31T13:30', '2027-04-01T18:30');
const options = [
  { id: '1', out: seg('CX0V1', 'HKG', 'YVR', 'Vancouver', '2027-02-19T11:40', '2027-02-19T07:40'), back, fare_hkd: 8420, note: '' },
  { id: '2', out: seg('CX0V3', 'HKG', 'YVR', 'Vancouver', '2027-02-19T23:50', '2027-02-19T19:50'), back, fare_hkd: 7960, note: '' },
  { id: '3', out: seg('CX0T1', 'HKG', 'YVR', 'Vancouver', '2027-02-19T09:10', '2027-02-19T09:40', ['NRT']), back, fare_hkd: 6900, note: 'via Tokyo, 4.5 hours longer' },
];
const page = { member_id: member.member_id, options, ref: null, expires: '2027-04-02T00:00:00Z' };
const order = (over = {}) => ({
  ref: 'K7Q2XM', member_id: member.member_id, status: 'held', option_id: '1',
  out: options[0].out, back, fare_hkd: 8420, cabin: 'economy', seat: 'window', meal: 'vegetarian',
  ssr: ['WCHR'], payer: 'Daniel Wong', passenger: 'WONG TAK MING', ...over,
});
const now = new Date('2026-11-14T12:00:00Z');
const link = `https://cate-demo.example.com/v/${'a'.repeat(22)}`;
const SAFE = 'Cathay never asks for passwords or card numbers here.';

const render = (o, p = page, at = now) => renderTripPage({ page: p, order: o, profile: member, now: at });
const allPages = () => ({
  options: render(null),
  held: render(order(), { ...page, ref: 'K7Q2XM' }),
  confirmed: render(order({ status: 'paid' })),
  ended: render(order({ status: 'ended' })),
  expired: render(order(), page, new Date('2027-04-03T00:00:00Z')),
  notFound: notFoundPage(),
});

test('options: the three flights in words, fares marked illustrative', () => {
  const html = render(null);
  assert.match(html, /Your Vancouver flights/);
  for (const t of ['Friday 19 February', '11:40', '23:50', '09:10', 'HKD 8,420', 'HKD 7,960', 'HKD 6,900', 'Via Tokyo', 'Wednesday 31 March']) {
    assert.ok(html.includes(t), `missing ${t}`);
  }
  assert.match(html, /illustrative fares/i);
  assert.ok(!html.includes('Held for you'));
  assert.ok(html.includes(SAFE));
});

test('held: still the options, with the held one marked', () => {
  const html = render(order({ option_id: '2' }));
  assert.match(html, /trip is held/);
  assert.match(html, /Waiting for Daniel to pay/);
  assert.equal(html.split('Held for you').length - 1, 1);
  const heldItem = html.split('<li').find((li) => li.includes('Held for you'));
  assert.ok(heldItem.includes('23:50'), 'the mark sits on option 2');
  assert.ok(html.includes('K7Q2XM'));
});

test('confirmed: reference, both flights, seat, meal, assistance, needs card', () => {
  const html = render(order({ status: 'paid' }));
  for (const t of ['booked to Vancouver', 'K7Q2XM', 'CX0V1', 'CX0V2', 'Friday 19 February', 'Wednesday 31 March', '13:30',
    'Thursday 1 April', 'Window', 'Vegetarian', 'WONG TAK MING', 'show this card to staff',
    'Wheelchair from check-in to the gate · WCHR', 'Please speak slowly', 'illustrative fare']) {
    assert.ok(html.includes(t), `missing ${t}`);
  }
  assert.ok(html.includes(SAFE));
});

test('needs card: plain words + code for each wheelchair code', () => {
  const words = { WCHR: 'to the gate', WCHS: 'cannot climb stairs', WCHC: 'cannot walk' };
  for (const [code, phrase] of Object.entries(words)) {
    const html = render(order({ status: 'paid', ssr: [code] }));
    assert.match(html, new RegExp(`Wheelchair [a-z -]+ · ${code}<`), code);
    assert.ok(html.includes(phrase), `${code}: ${phrase}`);
  }
  const none = render(order({ status: 'paid', ssr: [] }));
  assert.ok(none.includes('None requested'));
  assert.ok(!/WCH[RSC]/.test(none));
});

test('ended: an ended hold, and any page past its expiry', () => {
  const { ended, expired } = allPages();
  for (const html of [ended, expired]) {
    assert.match(html, /This hold has ended/);
    assert.ok(!html.includes('K7Q2XM') && !html.includes('11:40'));
  }
  assert.match(render(order({ status: 'paid' }), page, new Date('2027-04-03T00:00:00Z')), /This trip page has ended/);
});

test('no page prints phone, email or member number', () => {
  for (const [name, html] of Object.entries(allPages())) {
    for (const secret of PRIVATE) assert.ok(!html.includes(secret), `${name} leaks ${secret}`);
  }
});

test('every page: view only, zoomable, not indexed, nothing loaded from elsewhere', () => {
  for (const [name, html] of Object.entries(allPages())) {
    assert.ok(html.startsWith('<!doctype html>'), name);
    assert.ok(html.includes('<meta name="robots" content="noindex">'), name);
    assert.ok(!/maximum-scale|user-scalable/.test(html), name);
    assert.ok(!/<(form|button|input|script|link|img|iframe)\b/i.test(html), name);
    assert.ok(!/https?:\/\//.test(html), name);
  }
});

test('values are HTML-escaped', () => {
  const evil = '<script>alert(1)</script>';
  const evilSeg = { ...options[0].out, city: evil, flight: evil };
  const evilOptions = [{ ...options[0], id: evil, out: evilSeg, note: evil }];
  const pages = [
    render(null, { ...page, options: evilOptions }),
    render(order({ out: evilSeg, option_id: evil, payer: evil, ref: evil }), { ...page, options: evilOptions }),
    render(order({ status: 'paid', out: evilSeg, passenger: evil, ref: evil, seat: evil, meal: evil, ssr: [evil], payer: evil })),
    renderTripPage({ page, order: order({ status: 'paid', passenger: '' }), profile: { name: evil }, now }),
  ];
  for (const html of pages) {
    assert.ok(!html.includes('<script'), 'raw tag in page');
    assert.ok(html.includes('&lt;script&gt;'));
  }
});

test('notFoundPage carries no booking data', () => {
  const html = notFoundPage();
  assert.match(html, /Not found/);
  for (const t of ['K7Q2XM', 'WONG', 'Wong', 'Vancouver', 'CX0', 'HKD', 'WCH', 'Daniel']) assert.ok(!html.includes(t), t);
  assert.equal(renderTripPage({ page: undefined, order: null, profile: null, now }), html);
});

const ASCII = /^[\x20-\x7E\n]*$/;

test('SMS: plain ASCII, starts with Cathay CATE, every detail in the text', () => {
  const t1 = optionsSms(options, link);
  const t2 = bookedSms(order({ status: 'paid' }), member, link);
  const pay = payRequestSms(order(), 'Wong Tak Ming');
  for (const t of [t1, t2, pay]) {
    assert.match(t, ASCII);
    assert.ok(t.startsWith('Cathay CATE:'));
    for (const secret of PRIVATE) assert.ok(!t.includes(secret));
  }
  assert.ok(t1.length <= 306, `text 1 is ${t1.length} characters`);
  for (const s of ['1) Fri 19 Feb 11:40, HKD 8420', '2) Fri 19 Feb 23:50, HKD 7960', '3) Fri 19 Feb 09:10 via Tokyo, HKD 6900', 'Back Wed 31 Mar', link, 'never asks for card numbers']) {
    assert.ok(t1.includes(s), `text 1 missing ${s}`);
  }
  for (const s of ['K7Q2XM', 'CX0V1', 'Fri 19 Feb 11:40', 'Hong Kong to Vancouver', 'Wed 31 Mar 13:30', 'Wheelchair from check-in to the gate, WCHR', `Same link: ${link}`]) {
    assert.ok(t2.includes(s), `text 2 missing ${s}`);
  }
  for (const s of ['Wong Tak Ming', 'Reply PAY', 'HKD 8420', 'K7Q2XM', 'Vancouver']) assert.ok(pay.includes(s), `pay text missing ${s}`);
});

test('SMS: stays ASCII and within 2 parts with awkward input', () => {
  const odd = options.map((o) => ({ ...o, out: { ...o.out, city: 'Zürich – “West”' }, note: 'via São Paulo, longer' }));
  const longLink = `https://a-very-long-preview-host-name.execute-api.ap-east-1.example.com/v/${'b'.repeat(22)}`;
  const t1 = optionsSms(odd, longLink);
  assert.match(t1, ASCII);
  assert.ok(t1.length <= 306, `${t1.length} characters`);
  assert.ok(t1.includes('Zurich') && t1.includes('3) Fri 19 Feb 09:10'));
  assert.match(bookedSms(order({ status: 'paid', passenger: 'WONG TÁK MĪNG' }), member, link), ASCII);
  assert.match(payRequestSms(order(), 'Mr Wong’s'), ASCII);
});

test('payEmail with a pay link: one big Pay button', () => {
  const m = payEmail({ order: order(), travellerName: 'Wong Tak Ming', payerName: 'Daniel Wong', payUrl: 'https://pay.example.com/c/cs_test_1?a=1&b=2' });
  assert.ok(m.subject.includes('Wong Tak Ming') && m.subject.includes('K7Q2XM'));
  assert.ok(m.html.includes('href="https://pay.example.com/c/cs_test_1?a=1&amp;b=2"'));
  assert.ok(m.html.includes('>Pay HKD 8,420</a>'));
  assert.ok(!m.html.includes('Reply PAY'));
  assert.ok(m.text.includes('https://pay.example.com/c/cs_test_1?a=1&b=2'));
  for (const body of [m.html, m.text]) {
    for (const s of ['Hello Daniel', 'Wong Tak Ming', 'Vancouver', 'Friday 19 February', 'HKD 8,420', 'K7Q2XM', 'test payment standing in for Cathay']) {
      assert.ok(body.includes(s), `missing ${s}`);
    }
  }
});

test('payEmail without a pay link: reply PAY to the text', () => {
  for (const payUrl of [null, 'javascript:alert(1)']) {
    const m = payEmail({ order: order(), travellerName: 'Wong Tak Ming', payerName: 'Daniel Wong', payUrl });
    assert.ok(m.html.includes('Reply PAY to the text message we sent you'));
    assert.match(m.text, /reply PAY to the text message we sent you/i);
    assert.ok(!m.html.includes('<a '));
    assert.ok(!m.html.includes('javascript:') && !m.text.includes('javascript:'));
  }
});

test('payEmail: inline styles only, text of 20 px or more, values escaped', () => {
  const m = payEmail({ order: order(), travellerName: '<script>x</script>', payerName: 'Daniel Wong', payUrl: null });
  assert.ok(!/<(style|script|img|link)\b/i.test(m.html));
  assert.ok(m.html.includes('&lt;script&gt;'));
  const sizes = [...m.html.matchAll(/font-size:(\d+)px/g)].map((x) => Number(x[1]));
  assert.ok(sizes.length > 0 && Math.min(...sizes) >= 20, `smallest text is ${Math.min(...sizes)} px`);
  for (const secret of PRIVATE) assert.ok(!m.html.includes(secret) && !m.text.includes(secret));
});
