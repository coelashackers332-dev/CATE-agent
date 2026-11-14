// Outgoing SMS and email. mode 'log' prints them to the console; 'live' sends SMS through Twilio and email
// through a mail account (EMAIL_USER + EMAIL_APP_PASSWORD in .env: a Gmail address and its app password).
import { randomUUID } from 'node:crypto';
import tls from 'node:tls';
import twilio from 'twilio';
import { config } from './config.js';
import { emit } from './events.js';
import { store } from './store.js';

const SMTP_TIMEOUT_MS = 20_000;

const maskPhone = (n) => `***${String(n).slice(-4)}`;
const maskEmail = (a) => String(a).replace(/^(.).*@/, '$1***@');
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// Events never carry phone numbers or email addresses, so the projector only sees that a message went out.
function report(action, ok, summary) {
  emit(store.activeCall?.id ?? null, 'system', { system: 'Messages', action, ok, summary });
}

/** The mail account from .env. Read here, so the shared config.js stays unchanged. */
const emailFromEnv = () => ({ user: process.env.EMAIL_USER ?? '', pass: process.env.EMAIL_APP_PASSWORD ?? '' });

/** A header value: one line (so it can never start a new header), non-ASCII as an RFC 2047 encoded word. */
function headerText(value) {
  const line = String(value ?? '').replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7E]*$/.test(line) ? line : `=?UTF-8?B?${b64(line)}?=`;
}

/**
 * One email over SMTP, encrypted from the first byte (port 465). Resolves once the mail server has accepted it.
 * ponytail: just enough SMTP for one message to one address through Gmail, so no mail package is needed.
 * Production = Cathay's own mail service.
 */
function smtpSend({ user, pass, host = 'smtp.gmail.com', port = 465, connect = tls.connect }, { to, subject, html, text }) {
  // base64 keeps every line short and ASCII; no body line can be a lone "." (which would end the message early)
  // or contain the boundary ("=_" never appears in base64).
  const boundary = '=_cate_part';
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`
    + `${b64(body).replace(/.{76}/g, '$&\r\n')}\r\n`;
  const message = [
    `From: CATE demo <${user}>`,
    `To: <${to}>`,
    `Subject: ${headerText(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${user.split('@')[1]}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `${text ? part('text/plain', text) : ''}${html ? part('text/html', html) : ''}--${boundary}--`,
  ].join('\r\n');
  // Each step: the reply code the server must give, then what we say next.
  // Google shows an app password in four groups; the spaces are not part of it.
  const steps = [
    [220, 'EHLO localhost'],
    [250, `AUTH PLAIN ${b64(`\0${user}\0${pass.replace(/\s+/g, '')}`)}`],
    [235, `MAIL FROM:<${user}>`],
    [250, `RCPT TO:<${to}>`],
    [250, 'DATA'],
    [354, `${message}\r\n.`],
    [250, 'QUIT'],
  ];

  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host });
    const fail = (why) => { socket.destroy(); reject(new Error(why)); };
    let buffer = '';
    let first = '';   // first line of the reply being read: the one that says what went wrong
    let step = 0;
    socket.setEncoding('utf8');
    socket.setTimeout(SMTP_TIMEOUT_MS, () => fail('the mail server did not answer in time'));
    socket.on('error', (err) => fail(err.message));
    socket.on('close', () => reject(new Error('the mail server closed the connection early')));   // no effect once resolved
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\r\n')) !== -1;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        first ||= line;
        if (line[3] === '-') continue;   // "250-...": more lines of the same reply follow
        const reply = first;
        first = '';
        if (step === steps.length) return;   // the goodbye after QUIT
        const [code, say] = steps[step++];
        if (!reply.startsWith(String(code))) return fail(`the mail server said: ${reply}`);
        socket.write(`${say}\r\n`);
        if (step === steps.length) { resolve(); socket.end(); }
      }
    });
  });
}

export function createMessages({ mode = config.messages, email = emailFromEnv() } = {}) {
  let client = null;

  return {
    async sendSms(to, body) {
      if (mode !== 'live') {
        console.log(`[SMS] to ${maskPhone(to)}\n${body}\n`);
        report('send_sms', true, '✓ text sent (printed, not sent to a phone)');
        return;
      }
      try {
        client ??= twilio(config.twilio.accountSid, config.twilio.authToken);
        await client.messages.create({ from: config.twilio.number, to, body });
      } catch (err) {
        report('send_sms', false, '✗ text not sent');
        throw new Error(`SMS to ${maskPhone(to)} failed: ${err.message}`);
      }
      report('send_sms', true, '✓ text sent');
    },

    async sendEmail(to, subject, html, text) {
      if (mode !== 'live') {
        console.log(`[EMAIL] to ${maskEmail(to)} | ${subject}\n${text ?? '(HTML only)'}\n`);
        report('send_email', true, '✓ email sent (printed, not sent to an inbox)');
        return;
      }
      try {
        if (!/^\S+@\S+$/.test(email.user ?? '') || !email.pass) throw new Error('live email needs EMAIL_USER (the full address) and EMAIL_APP_PASSWORD in .env');
        if (!/^[^\s<>]+@[^\s<>]+$/.test(to ?? '')) throw new Error('that is not an email address');
        await smtpSend(email, { to, subject, html, text });
      } catch (err) {
        report('send_email', false, '✗ email not sent');
        throw new Error(`Email to ${maskEmail(to)} failed: ${err.message}`);
      }
      report('send_email', true, '✓ email sent');
    },
  };
}
