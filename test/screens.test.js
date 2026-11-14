import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderTripPage, notFoundPage } from '../src/screens/trip.js';
import { optionsSms, bookedSms, payRequestSms } from '../src/screens/texts.js';
import { payEmail, tripEmail, bookedEmail } from '../src/screens/emails.js';

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

const withPay = (o, payUrl) => renderTripPage({ page, order: o, profile: member, now, payUrl });
const self = { payer: 'Wong Tak Ming' };   // nobody else pays: the order names the traveller himself

test('held with a pay link: one big Pay button to the payment page', () => {
  const html = withPay(order(self), 'https://pay.example.com/c/cs_test_1?a=1&b=2');
  assert.match(html, /Pay to confirm your booking/);
  assert.ok(html.includes('href="https://pay.example.com/c/cs_test_1?a=1&amp;b=2"'));
  assert.ok(html.includes('>Pay HKD 8,420</a>'));
  assert.equal(html.split('<a ').length - 1, 1, 'exactly one link');
  assert.ok(!html.includes('Waiting for'));
  assert.ok(html.includes(SAFE), 'the page itself still never asks for card numbers');
  assert.ok(!/<(form|button|input|link|img|iframe)\b/i.test(html));
  assert.ok(withPay(order(self), '/pay/abc').includes('href="/pay/abc"'), 'a path on our own server works too');
});

test('held, someone else asked to pay, with a pay link: both ways stay open', () => {
  const html = withPay(order(), 'https://pay.example.com/c/1');   // payer: Daniel Wong
  assert.match(html, /Waiting for Daniel to pay/);
  assert.match(html, /You can also pay yourself/);
  assert.ok(html.includes('>Pay HKD 8,420</a>'));
});

// What an open page compares to know the booking has changed.
const version = (html) => /<html[^>]* data-v="([^"]*)"/.exec(html)?.[1];

test('pages that can still change keep themselves up to date; finished pages stay still', () => {
  const live = { options: render(null), held: render(order()), 'held with pay': withPay(order(self), '/pay/abc') };
  for (const [name, html] of Object.entries(live)) {
    assert.equal(html.split('<script').length - 1, 1, `${name}: one script`);
    assert.ok(!/<script[^>]+src=/i.test(html), `${name}: the script is inline, nothing is loaded`);
    assert.ok(html.includes('location.reload()') && html.includes('fetch(location.href'), `${name}: re-reads its own address only`);
    assert.ok(version(html), `${name}: carries a version`);
  }
  const { confirmed, ended, expired, notFound } = allPages();
  for (const [name, html] of Object.entries({ confirmed, ended, expired, notFound })) {
    assert.ok(!html.includes('<script'), `${name}: no script`);
  }
});

test('the version changes when the booking changes, and only then', () => {
  assert.equal(version(render(null)), version(render(null)));
  assert.equal(version(render(order())), version(render(order())));
  const seen = [render(null), render(order()), render(order({ option_id: '2' })), withPay(order(), '/pay/abc'), withPay(order(self), '/pay/abc')].map(version);
  assert.equal(new Set(seen).size, seen.length, `each state has its own version: ${seen.join(' ')}`);
});

test('the Pay button shows only while held, and only for a web link', () => {
  const payUrl = 'https://pay.example.com/c/1';
  const none = {
    options: withPay(null, payUrl),
    booked: withPay(order({ status: 'paid' }), payUrl),
    ended: withPay(order({ status: 'ended' }), payUrl),
    'held, no link': render(order()),
    'held, script link': withPay(order(), 'javascript:alert(1)'),
    'held, other-site trick': withPay(order(), '//evil.example.com/pay'),
    'held, backslash trick': withPay(order(), '/\\evil.example.com/pay'),
  };
  for (const [name, html] of Object.entries(none)) {
    assert.ok(!html.includes('<a ') && !html.includes('javascript:') && !html.includes('evil'), name);
  }
});

test('paying himself: the page never says "Wong paid" or "Waiting for Wong"', () => {
  assert.match(render(order(self)), /Waiting for payment/);
  const paid = render(order({ ...self, status: 'paid' }));
  assert.ok(paid.includes('Paid. Booking reference K7Q2XM.'));
  assert.ok(!paid.includes('Wong paid'));
});

test('confirmed: reference, both flights, seat, meal, assistance, needs card', () => {
  const html = render(order({ status: 'paid' }));
  for (const t of ['booked to Vancouver', 'K7Q2XM', 'CX0V1', 'CX0V2', 'Friday 19 February', 'Wednesday 31 March', '13:30',
    'Thursday 1 April', 'Window', 'Vegetarian', 'WONG TAK MING', 'show this card to staff',
    'Wheelchair from check-in to the gate · WCHR', 'Please speak slowly', 'illustrative fare']) {
    assert.ok(html.includes(t), `missing ${t}`);
  }
  assert.ok(html.includes(SAFE));
  assert.ok(html.indexOf('show this card to staff') < html.indexOf('Your flights'), 'the needs card comes before the flights');
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
    assert.ok(!/<(form|button|input|link|img|iframe)\b/i.test(html), name);
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
    assert.ok(!html.includes('<script>alert'), 'raw tag in page');
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
  assert.ok(t2.length <= 306, `text 2 is ${t2.length} characters`);
  for (const s of ['K7Q2XM', 'CX0V1 Fri 19 Feb 11:40', 'Hong Kong to Vancouver', 'Back CX0V2 Wed 31 Mar 13:30', 'Show staff: Wheelchair from check-in to the gate, WCHR. Please speak slowly.', `Trip: ${link}`]) {
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
  const t2 = bookedSms(order({ status: 'paid', passenger: 'WONG TÁK MĪNG' }), member, longLink);
  assert.match(t2, ASCII);
  assert.ok(t2.length <= 306, `text 2 is ${t2.length} characters`);
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

test('each option says when it lands, in local time, and says so when that is the next day', () => {
  const late = { ...options[1], out: { ...options[1].out, arr: '2027-02-20T06:10' } };
  const html = render(null, { ...page, options: [options[0], late] });
  assert.ok(html.includes('Arrives 07:40, Vancouver time'));
  assert.ok(html.includes('Arrives 06:10 the next day, Vancouver time'));
  assert.ok(!/lands d/.test(html), 'no bare "lands 07:40" next to the departure time');
});

// No SMS any more: the traveller gets his trip link, and later his booking, by email.
const fonts = (html) => [...html.matchAll(/font-size:(d+)px/g)].map((x) => Number(x[1]));

test('tripEmail: the flight options and one big button to the trip page', () => {
  const m = tripEmail({ options, link, travellerName: 'Wong Tak Ming' });
  assert.ok(m.subject.includes('Vancouver'));
  assert.equal(m.html.split('<a ').length - 1, 1, 'one link only');
  assert.ok(m.html.includes(`href="${link}"`) && m.html.includes('>Open your trip page</a>'));
  assert.ok(m.text.includes(link));
  for (const body of [m.html, m.text]) {
    for (const t of ['Hello Wong Tak Ming', 'Friday 19 February', '11:40', '23:50', '09:10', 'HKD 8,420', 'HKD 6,900', 'via Tokyo', 'Wednesday 31 March', 'Illustrative fares', 'never asks for passwords or card numbers']) {
      assert.ok(body.includes(t), `missing ${t}`);
    }
  }
});

test('bookedEmail: booked, the needs for staff, and the trip page link', () => {
  const m = bookedEmail({ order: order({ status: 'paid' }), profile: member, link });
  assert.ok(m.subject.includes('K7Q2XM') && /booked/i.test(m.subject));
  assert.ok(m.html.includes(`href="${link}"`) && m.html.includes('>Open your needs card</a>'));
  for (const body of [m.html, m.text]) {
    for (const t of ['Daniel paid', 'K7Q2XM', 'WONG TAK MING', 'CX0V1', 'Friday 19 February', 'Wednesday 31 March', 'Wheelchair from check-in to the gate', 'WCHR', 'Please speak slowly', 'Window seat', 'Vegetarian meal']) {
      assert.ok(body.includes(t), `missing ${t}`);
    }
  }
});

test('traveller emails: inline styles only, text of 20 px or more, escaped, nothing private, web links only', () => {
  const odd = options.map((o) => ({ ...o, note: '<script>x</script>' }));
  const mails = [
    tripEmail({ options: odd, link, travellerName: 'Wong Tak Ming' }),
    bookedEmail({ order: order({ status: 'paid', passenger: '<b>WONG</b>' }), profile: member, link }),
  ];
  for (const m of mails) {
    assert.ok(!/<(style|script|img|link)/i.test(m.html));
    assert.ok(Math.min(...fonts(m.html)) >= 20, `smallest text is ${Math.min(...fonts(m.html))} px`);
    for (const secret of PRIVATE) assert.ok(!m.html.includes(secret) && !m.text.includes(secret));
  }
  assert.ok(mails[0].html.includes('&lt;script&gt;') && mails[1].html.includes('&lt;b&gt;WONG'));
  for (const bad of ['javascript:alert(1)', '//evil.example.com/v/x']) {
    assert.ok(!tripEmail({ options, link: bad, travellerName: 'Wong Tak Ming' }).html.includes('<a '), `${bad} must not become a button`);
  }
});

// While his call is live, the page also takes the caller's answers by button: the same answers he can say aloud.
const liveRender = (live, o = null) => renderTripPage({ page, order: o, profile: member, now, live });
const buttons = (html) => [...html.matchAll(/<button[^>]*name="(\w+)" value="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => `${m[1]}=${m[2]}|${m[3]}`);

test('answers by button, nothing chosen yet: each flight has its own Choose button, posting to the page itself', () => {
  const html = liveRender({ choice: null, payer: null, family: 'Daniel' });
  assert.deepEqual(buttons(html), ['option=1|Choose flight 1', 'option=2|Choose flight 2', 'option=3|Choose flight 3']);
  assert.match(html, /<form method="post">/, 'no action: the answer goes to this page\'s own address');
  assert.ok(html.includes('Tap a flight, or say its number on the call.'));
  assert.ok(!html.includes('Who pays?'), 'one question at a time');
  assert.ok(html.includes(SAFE));
  assert.ok(!/<(input|select|textarea|link|img|iframe)\b/i.test(html), 'buttons only: nothing to type');
});

test('answers by button, a flight chosen: it is marked, the others offer a change, and the page asks who pays', () => {
  const html = liveRender({ choice: '2', payer: null, family: 'Daniel' });
  assert.match(html, /You chose flight 2/);
  assert.match(html, /Nothing is booked until you say yes/);
  const chosen = html.split('<li').find((li) => li.includes('Your choice'));
  assert.ok(chosen.includes('23:50') && !chosen.includes('<button'), 'the mark sits on flight 2, which needs no button');
  assert.equal(html.split('Your choice').length - 1, 1);
  assert.deepEqual(buttons(html), ['payer=self|I pay myself', 'payer=family|Ask Daniel to pay', 'option=1|Change to flight 1', 'option=3|Change to flight 3']);
  assert.ok(html.indexOf('Who pays?') < html.indexOf('Change to flight 1'), 'the open question comes first');
});

test('answers by button, payer chosen: the page says who pays and offers the other way', () => {
  const family = liveRender({ choice: '1', payer: 'family', family: 'Daniel' });
  assert.match(family, /Daniel will be asked to pay/);
  assert.ok(buttons(family).includes('payer=self|I pay myself instead'));
  assert.ok(!buttons(family).some((b) => b.startsWith('payer=family')));
  const self = liveRender({ choice: '1', payer: 'self', family: 'Daniel' });
  assert.match(self, /You pay yourself/);
  assert.ok(buttons(self).includes('payer=family|Ask Daniel to pay instead'));
});

test('answers by button: with no family payer on file the page does not ask who pays', () => {
  const html = liveRender({ choice: '1', payer: null, family: '' });
  assert.ok(!html.includes('Who pays?') && !buttons(html).some((b) => b.startsWith('payer=')));
  assert.match(html, /You chose flight 1/);
});

test('answers by button: only before the hold; names and ids are escaped; each answer changes the version', () => {
  const live = { choice: '1', payer: 'self', family: 'Daniel' };
  for (const o of [order(), order({ status: 'paid' }), order({ status: 'ended' })]) {
    assert.ok(!/<(form|button)\b/i.test(liveRender(live, o)), `${o.status}: no buttons`);
  }
  const bad = '"><script>alert(1)</script>';
  const odd = (choice) => renderTripPage({ page: { ...page, options: [{ ...options[0], id: bad }, options[1]] }, profile: member, now, live: { choice, payer: null, family: '<b>x' } });
  for (const html of [odd(null), odd(bad), odd('2')]) assert.ok(!html.includes('<script>alert') && !html.includes('<b>x'));
  assert.ok(odd(bad).includes('Ask &lt;b&gt;x to pay'), 'the who-pays question is there, escaped');
  const seen = [null, '1', '2'].map((choice) => version(liveRender({ choice, payer: null, family: 'Daniel' })));
  seen.push(version(liveRender({ choice: '2', payer: 'self', family: 'Daniel' })), version(render(null)));
  assert.equal(new Set(seen).size, seen.length, `each state has its own version: ${seen.join(' ')}`);
});
