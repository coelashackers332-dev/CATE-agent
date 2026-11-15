// Outgoing texts and email. mode 'log' prints them to the console; 'live' sends email through a mail account
// (EMAIL_USER + EMAIL_APP_PASSWORD in .env: a Gmail address and its app password).
// There is no SMS sender (the phone line is a Bluetooth phone, not Twilio), so with TEXTS=email (the default) each
// text goes as an email to the address on file for that phone number. TEXTS=sms only prints.
import { randomUUID } from 'node:crypto';
import tls from 'node:tls';
import { config } from './config.js';
import { emit } from './events.js';
import { store } from './store.js';

const SMTP_TIMEOUT_MS = 20_000;

const maskPhone = (n) => `***${String(n).slice(-4)}`;
const maskEmail = (a) => String(a).replace(/^(.).*@/, '$1***@');
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
/** The mail server's error text can quote a number or an address: mask them before anything logs it. */
const scrub = (s) => String(s).replace(/\+\d{7,15}/g, maskPhone).replace(/[^\s<>()"']+@[^\s<>()"']+/g, maskEmail);

// Events never carry phone numbers or email addresses, so the projector only sees that a message went out.
function report(action, ok, summary) {
  emit(store.activeCall?.id ?? null, 'system', { system: 'Messages', action, ok, summary });
}

/** The mail account from .env. Read here, so the shared config.js stays unchanged. */
const emailFromEnv = () => ({ user: process.env.EMAIL_USER ?? '', pass: process.env.EMAIL_APP_PASSWORD ?? '' });

/** How texts go: email (the default) or sms (no sender: printed in log mode, refused in live mode). Read here too, for the same reason. */
const textsFromEnv = () => (process.env.TEXTS || 'email').trim().toLowerCase();

/**
 * TEXTS=email: the address on file for a phone number, the member's own or their family payer's.
 * Texts still only reach people on file: every number we text comes from the membership data, never from the model.
 * Spaces and dashes don't matter: "+852 0000 0001" in .env is the same as "+85200000001".
 * ponytail: reads the demo membership data. Production = the contact details in Cathay's member profile.
 */
function inboxFor(phone) {
  const digits = (n) => String(n ?? '').replace(/[^\d+]/g, '');
  const wanted = digits(phone);
  if (!wanted) return null;
  for (const member of store.members) {
    if (digits(member.phone) === wanted) return member.email;
    const delegate = member.delegates?.find((d) => digits(d.phone) === wanted);
    if (delegate) return delegate.email;
  }
  return null;
}

/** A header value: one line (so it can never start a new header), non-ASCII as an RFC 2047 encoded word. */
function headerText(value) {
  const line = String(value ?? '').replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7E]*$/.test(line) ? line : `=?UTF-8?B?${b64(line)}?=`;
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** A web link in a text, without the full stop or bracket that may follow it. */
const LINK = /(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)])/;

/**
 * TEXTS=email: a text as an email that reads well on a phone. The words are exactly the text's: its first line is
 * the heading (and the subject), each other line a paragraph, and each web link a big button. Inline styles only,
 * because mail apps drop style sheets; the look is Cavell's for emails: white, a jade brand line, 20 px text,
 * the button in #2c4036.
 */
function textAsEmail(body) {
  const [first = '', ...rest] = String(body).split('\n');
  const heading = first.replace(/^Cathay CATE:\s*/i, '');
  const para = (s) => `<p style="margin:0 0 14px;font-size:20px;line-height:1.45;color:#1f2a2a;">${escHtml(s)}</p>`;
  const button = (url) => {
    const label = /\/pay\//.test(url) ? 'Open the payment page' : /\/v\//.test(url) ? 'Open your trip' : 'Open the link';
    return `<p style="margin:6px 0 20px;"><a href="${escHtml(url)}" style="display:block;background:#2c4036;color:#ffffff;font-size:22px;`
      + `font-weight:bold;line-height:1.3;text-align:center;text-decoration:none;padding:16px 20px;border-radius:12px;">${label}</a></p>`;
  };
  // split() with a captured pattern keeps each link at an odd index, between the words around it.
  const lines = rest.map((line) => line.split(LINK).map((part, i) => (i % 2 ? button(part) : part.trim() ? para(part.trim()) : '')).join(''));
  return `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:560px;margin:0 auto;padding:24px 20px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2a2a;">
<p style="margin:0 0 20px;padding-bottom:10px;border-bottom:4px solid #005d63;font-size:16px;color:#005d63;"><b>Cathay</b> CATE</p>
<h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;color:#1f2a2a;">${escHtml(heading.charAt(0).toUpperCase() + heading.slice(1))}</h1>
${lines.filter(Boolean).join('\n')}
<p style="margin:24px 0 0;font-size:16px;line-height:1.4;color:#4f5c5c;">CATE prototype: this is a text message, sent by email.</p>
</div>
</body></html>`;
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

export function createMessages({ mode = config.messages, email = emailFromEnv(), texts = textsFromEnv() } = {}) {
  // A typo here would only show on stage, as texts that never arrive: stop the server at start instead.
  if (texts !== 'sms' && texts !== 'email') throw new Error(`TEXTS must be sms or email, not "${texts}"`);

  // The checks come first, so a missing login or a bad address never opens a connection.
  async function mail(to, subject, html, text) {
    if (!/^\S+@\S+$/.test(email.user ?? '') || !email.pass) throw new Error('live email needs EMAIL_USER (the full address) and EMAIL_APP_PASSWORD in .env');
    if (!/^[^\s<>]+@[^\s<>]+$/.test(to ?? '')) throw new Error('that is not an email address');
    await smtpSend(email, { to, subject, html, text });
  }

  return {
    async sendSms(to, body) {
      const inbox = texts === 'email' ? inboxFor(to) : null;
      const how = texts === 'email' ? ` by email (${inbox ? maskEmail(inbox) : 'no address on file'})` : '';
      if (mode !== 'live') {
        console.log(`[SMS] to ${maskPhone(to)}${how}\n${body}\n`);
        report('send_sms', true, '✓ text sent (printed, not sent to a phone)');
        return;
      }
      try {
        if (texts === 'email') {
          if (!inbox) throw new Error('no email address on file for that number');
          // The same words as the text, plain and laid out; its first line ("Cathay CATE: booked. Ref ...") is the subject.
          // The time makes each subject unique: with one subject Gmail stacks the texts into one conversation and hides
          // what repeats (the trip link button) behind "•••".
          const at = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit' }).format(new Date());
          await mail(inbox, `${String(body).split('\n')[0]} (${at})`, textAsEmail(body), body);
        } else {
          throw new Error('there is no SMS sender: set TEXTS=email');
        }
      } catch (err) {
        report('send_sms', false, '✗ text not sent');
        throw new Error(`SMS to ${maskPhone(to)}${how} failed: ${scrub(err.message)}`);
      }
      report('send_sms', true, texts === 'email' ? '✓ text sent by email' : '✓ text sent');
    },

    async sendEmail(to, subject, html, text) {
      if (mode !== 'live') {
        console.log(`[EMAIL] to ${maskEmail(to)} | ${subject}\n${text ?? '(HTML only)'}\n`);
        report('send_email', true, '✓ email sent (printed, not sent to an inbox)');
        return;
      }
      try {
        await mail(to, subject, html, text);
      } catch (err) {
        report('send_email', false, '✗ email not sent');
        throw new Error(`Email to ${maskEmail(to)} failed: ${scrub(err.message)}`);
      }
      report('send_email', true, '✓ email sent');
    },
  };
}
