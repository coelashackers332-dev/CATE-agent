// Live email and texts by email (src/messages.js) against a pretend mail server on this machine.
// Nothing leaves the laptop.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { config } from '../src/config.js';
import { bus } from '../src/events.js';
import { store } from '../src/store.js';
import { createMessages } from '../src/messages.js';

const USER = 'cate.team@example.com';
const PASS = 'abcd efgh ijkl mnop';   // as Google shows an app password
const TO = 'daniel@example.com';

/** A pretend SMTP server: says what a mail server says, and keeps what it was told. */
let smtp;
let seen;
let behave;
before(async () => {
  smtp = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    if (behave.hangUp) return socket.end();
    let buffer = '';
    let inMessage = false;
    socket.write('220 pretend.smtp ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inMessage) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          seen.message = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inMessage = false;
          socket.write('250 2.0.0 OK queued\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end === -1) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        seen.commands.push(line);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') socket.write('250-pretend.smtp at your service\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') socket.write(behave.rejectLogin ? '535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 Learn more at the help page\r\n' : '235 2.7.0 Accepted\r\n');
        else if (verb === 'RCPT' && behave.rejectRcpt) socket.write(`${behave.rejectRcpt}\r\n`);
        else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 2.1.0 OK\r\n');
        else if (verb === 'DATA') { inMessage = true; socket.write('354 Go ahead\r\n'); }
        else if (verb === 'QUIT') socket.end('221 2.0.0 closing connection\r\n');
      }
    });
  }).listen(0, '127.0.0.1');
  await once(smtp, 'listening');
});
after(() => smtp.close());

const events = [];
const onEvent = (ev) => events.push(ev);
before(() => bus.on('event', onEvent));
after(() => bus.off('event', onEvent));
before(() => store.reset({ log: false }));   // the membership data, where texts by email find their address
beforeEach(() => {
  seen = { commands: [], message: '' };
  behave = {};
  events.length = 0;
});

const live = (email = {}, texts = 'sms') => createMessages({
  mode: 'live',
  texts,
  email: { user: USER, pass: PASS, connect: () => net.connect(smtp.address().port, '127.0.0.1'), ...email },
});
const wong = () => store.members.find((m) => m.member_id === 'DEMO-0001');
const rcpts = () => seen.commands.filter((c) => c.startsWith('RCPT'));
const unbase64 = (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Split a received message into its headers and its decoded parts. */
function parse(message) {
  const [head, ...rest] = message.split('\r\n\r\n');
  const headers = Object.fromEntries(head.split('\r\n').map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 2)]));
  const boundary = /boundary="([^"]+)"/.exec(headers['content-type'])[1];
  const parts = rest.join('\r\n\r\n').split(`--${boundary}`).slice(1, -1).map((p) => {
    const [partHead, body] = p.trim().split('\r\n\r\n');
    return { type: /Content-Type: ([^;]+)/.exec(partHead)[1], text: unbase64(body) };
  });
  return { headers, parts };
}

test('live email: logs in, sends text and HTML to the one address, and tells the projector without the address', async () => {
  const html = `<p style="font-size:20px">Hello Daniel, pay for flight K7Q2XM · 你好</p>${'<p>long line </p>'.repeat(200)}`;
  const text = 'Hello Daniel,\n.\nA line with only a dot above must not end the message.\nPay: https://cate.test/pay/abc';
  await live().sendEmail(TO, "Payment request: Wong Tak Ming's Cathay flight to Vancouver (K7Q2XM)", html, text);

  const login = seen.commands.find((c) => c.startsWith('AUTH PLAIN '));
  assert.equal(unbase64(login.slice(11)), `\0${USER}\0abcdefghijklmnop`, 'the spaces Google shows are not part of the password');
  assert.deepEqual(seen.commands.filter((c) => /^(MAIL|RCPT)/.test(c)), [`MAIL FROM:<${USER}>`, `RCPT TO:<${TO}>`]);
  await until(() => seen.commands.at(-1) === 'QUIT', 'the goodbye, sent once the message is accepted');

  const { headers, parts } = parse(seen.message);
  assert.equal(headers.from, `CATE demo <${USER}>`);
  assert.equal(headers.to, `<${TO}>`);
  assert.equal(headers.subject, "Payment request: Wong Tak Ming's Cathay flight to Vancouver (K7Q2XM)");
  assert.match(headers.date, /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
  assert.deepEqual(parts, [{ type: 'text/plain', text }, { type: 'text/html', text: html }]);
  assert.match(seen.message, /^[\x00-\x7F]*$/, 'only plain characters on the wire');
  assert.ok(seen.message.split('\r\n').every((l) => l.length <= 78), 'short lines only: the long HTML is wrapped');

  const told = events.filter((e) => e.system === 'Messages');
  assert.deepEqual(told.map((e) => [e.action, e.ok, e.summary]), [['send_email', true, '✓ email sent']]);
  assert.doesNotMatch(JSON.stringify(events), /@example\.com/);
});

test('live email: a wrong password fails with what the mail server said, never the address or the password', async () => {
  behave.rejectLogin = true;
  const failure = await live().sendEmail(TO, 'Pay', '<p>h</p>', 'h').then(() => null, (err) => err);
  assert.match(failure.message, /^Email to d\*\*\*@example\.com failed: the mail server said: 535-5\.7\.8 Username and Password not accepted/);
  assert.doesNotMatch(failure.message, /daniel@|abcd|mnop/);
  assert.equal(seen.message, '', 'nothing was sent');
  assert.deepEqual(events.filter((e) => e.system === 'Messages').map((e) => [e.ok, e.summary]), [[false, '✗ email not sent']]);
});

test('live email: no login, or something that is not an address, is refused before any connection', async () => {
  const noConnection = () => assert.fail('must not connect');
  await assert.rejects(live({ user: '', pass: '', connect: noConnection }).sendEmail(TO, 's', '<p>h</p>', 'h'), /EMAIL_USER/);
  await assert.rejects(live({ pass: '', connect: noConnection }).sendEmail(TO, 's', '<p>h</p>', 'h'), /EMAIL_APP_PASSWORD/);
  await assert.rejects(live({ user: 'cate.team', connect: noConnection }).sendEmail(TO, 's', '<p>h</p>', 'h'), /full address/);
  for (const bad of ['', undefined, 'daniel', 'a@b.com>\r\nRCPT TO:<evil@x.com', 'a b@c.com', '<a@b.com>']) {
    await assert.rejects(live({ connect: noConnection }).sendEmail(bad, 's', '<p>h</p>', 'h'), /not an email address/, String(bad));
  }
});

test('live email: a subject cannot add headers, and other alphabets are encoded', async () => {
  await live().sendEmail(TO, 'Pay\r\nBcc: evil@x.com', '<p>h</p>', 'h');
  assert.equal(parse(seen.message).headers.subject, 'Pay Bcc: evil@x.com');
  assert.doesNotMatch(seen.message, /^Bcc:/m);

  await live().sendEmail(TO, '付款 K7Q2XM', '<p>h</p>', 'h');
  const subject = parse(seen.message).headers.subject;
  assert.equal(unbase64(/^=\?UTF-8\?B\?(.+)\?=$/.exec(subject)[1]), '付款 K7Q2XM');
});

test('live email: a mail server that hangs up is an error, not a hang', async () => {
  behave.hangUp = true;
  await assert.rejects(live().sendEmail(TO, 's', '<p>h</p>', 'h'), /Email to d\*\*\*@example\.com failed: the mail server closed the connection early/);
});

test('a number or an address that the mail server quotes back is masked in the error', async () => {
  behave.rejectRcpt = '550 5.1.1 <daniel@example.com> (+85200000042) does not exist';
  const failure = await live().sendEmail(TO, 's', '<p>h</p>', 'h').then(() => null, (err) => err);
  assert.match(failure.message, /the mail server said: 550 5\.1\.1 <d\*\*\*@example\.com> \(\*\*\*0042\) does not exist$/);
  assert.doesNotMatch(failure.message, /daniel@|\+852/);
});

test('texts by email: each text goes to the address on file for that number, its first line as the subject', async () => {
  const daniel = wong().delegates[0];
  const text = 'Cathay CATE: booked. Ref K7Q2XM, WONG TAK MING.\nSame link: https://cate.test/v/abc';
  await live({}, 'email').sendSms(wong().phone, text);
  assert.deepEqual(rcpts(), [`RCPT TO:<${wong().email}>`]);
  const { headers, parts } = parse(seen.message);
  assert.match(headers.subject, /^Cathay CATE: booked\. Ref K7Q2XM, WONG TAK MING\. \(\d\d:\d\d\)$/, 'first line, plus the time so Gmail does not stack them');
  assert.deepEqual(parts.map((p) => p.type), ['text/plain', 'text/html']);
  assert.equal(parts[0].text, text, 'the plain part: the same words as the text, nothing added');

  await live({}, 'email').sendSms(daniel.phone, 'Cathay CATE: Wong Tak Ming asks you to pay for a flight.');
  assert.equal(rcpts().at(-1), `RCPT TO:<${daniel.email}>`, "the family payer's own address");

  const told = events.filter((e) => e.system === 'Messages').map((e) => [e.action, e.ok, e.summary]);
  assert.deepEqual(told, [['send_sms', true, '✓ text sent by email'], ['send_sms', true, '✓ text sent by email']]);
  assert.doesNotMatch(JSON.stringify(events), /@|\+\d{8}/, 'no address or number reaches the projector');
});

test('texts by email: the laid-out part has the same words, each link as a big button, and nothing from the text as HTML', async () => {
  const text = 'Cathay CATE: your Vancouver flights\n1) Fri 19 Feb 11:40, HKD 8420\n\nBack Wed 31 Mar. Big-text view: https://cate.test/v/abc\n<b>not bold</b> & "co"';
  await live({}, 'email').sendSms(wong().phone, text);
  const html = parse(seen.message).parts[1].text;
  assert.match(html, /<h1 [^>]*>Your Vancouver flights<\/h1>/, 'the first line is the heading');
  assert.match(html, /<p [^>]*>1\) Fri 19 Feb 11:40, HKD 8420<\/p>/);
  assert.match(html, /<p [^>]*>Back Wed 31 Mar\. Big-text view:<\/p>\s*<p [^>]*><a href="https:\/\/cate\.test\/v\/abc" [^>]*>Open your trip<\/a><\/p>/);
  assert.match(html, /&lt;b&gt;not bold&lt;\/b&gt; &amp; &quot;co&quot;/);
  assert.doesNotMatch(html, /<b>not bold|<p [^>]*><\/p>/, 'no HTML from the text, and no empty paragraphs');
});

test('texts by email: a number on file written with spaces, as people type it in .env, still finds its address', async () => {
  const member = wong();
  const onFile = member.phone;
  member.phone = '+852 0000 0042';
  try {
    await live({}, 'email').sendSms('+85200000042', 'Cathay CATE: your Vancouver flights');   // as the caller's number is stored on the call
  } finally {
    member.phone = onFile;
  }
  assert.deepEqual(rcpts(), [`RCPT TO:<${member.email}>`]);
});

test('texts by email: a number with no address on file is refused before any connection', async () => {
  const failure = await live({ connect: () => assert.fail('must not connect') }, 'email')
    .sendSms('+85200000098', 'Cathay CATE: hello').then(() => null, (err) => err);
  assert.equal(failure.message, 'SMS to ***0098 by email (no address on file) failed: no email address on file for that number');
  assert.deepEqual(events.filter((e) => e.system === 'Messages').map((e) => [e.ok, e.summary]), [[false, '✗ text not sent']]);
});

test('TEXTS=sms in live mode: there is no SMS sender, so the text is refused and nothing connects', async () => {
  const failure = await live({ connect: () => assert.fail('must not connect') }, 'sms')
    .sendSms(wong().phone, 'Cathay CATE: hello').then(() => null, (err) => err);
  assert.match(failure.message, /^SMS to \*\*\*\d{4} failed: there is no SMS sender: set TEXTS=email$/);
  assert.deepEqual(events.filter((e) => e.system === 'Messages').map((e) => [e.ok, e.summary]), [[false, '✗ text not sent']]);
});

test('TEXTS must be sms or email: a typo stops the server at start, not on stage', () => {
  assert.throws(() => createMessages({ mode: 'log', texts: 'emial' }), /TEXTS must be sms or email, not "emial"/);
});

test('log mode prints the email and the routed text with the address and number masked, and never connects', async () => {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const logOnly = (texts) => createMessages({ mode: 'log', texts, email: { user: USER, pass: PASS, connect: () => assert.fail('must not connect') } });
    await logOnly('sms').sendEmail(TO, 'Pay for a flight', '<p>hi</p>', 'hi');
    await logOnly('email').sendSms(wong().phone, 'Cathay CATE: hi');
  } finally {
    console.log = log;
  }
  assert.match(lines[0], /^\[EMAIL\] to d\*\*\*@example\.com \| Pay for a flight\nhi/);
  const [name, domain] = wong().email.split('@');
  assert.equal(lines[1], `[SMS] to ***${wong().phone.slice(-4)} by email (${name[0]}***@${domain})\nCathay CATE: hi\n`);
  assert.ok(!lines.join('').includes(wong().phone) && !lines.join('').includes(`${name}@`));
});
