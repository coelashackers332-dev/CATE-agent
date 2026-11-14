// What happens when a booking is paid, and the pay page that starts it. Payment arrives from the pay page
// (/pay/<trip page code>, a demo: no money moves) or from a PAY text while Twilio is in use ('sms').
import { randomBytes } from 'node:crypto';
import { emit } from './events.js';
import { store, findOrder, findMember, setOrderStatus } from './store.js';
import { methodLabel, renderPayPage, renderPaidPage } from './screens/pay.js';

const MAX_FORM = 2048;   // the pay form sends one short field
const PRIVATE = { 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

/** An HTML page with a fresh CSP nonce: only the page's own style and script run, and no other site can frame it. */
function sendPage(res, status, render) {
  const nonce = randomBytes(16).toString('base64');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', ...PRIVATE, 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; `
      + "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  }).end(render(nonce));
}

/** The fields of a small form POST, or null when the body is larger than MAX_FORM. */
async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FORM) return null;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * @param {object} deps  { messages, texts, baseUrl, emails? }. With `emails` (src/screens/emails.js) and texts going
 *                       by email (TEXTS=email, the default), the traveller gets the designed booked email instead of
 *                       text 2 laid out as an email.
 */
export function createPayment({ messages, texts, baseUrl, emails = null }) {
  // The trip page for this booking. CONTRACTS.md does not say who sets page.ref after the hold, so if no
  // page carries the ref yet, the member's latest page without one (made by text_options) is linked here.
  function tripLink(order) {
    const pages = [...store.pages];
    const entry = pages.find(([, page]) => page.ref === order.ref)
      ?? pages.findLast(([, page]) => page.ref == null && page.member_id === order.member_id);
    if (!entry) return '';
    entry[1].ref = order.ref;
    return `${baseUrl}/v/${entry[0]}`;
  }

  /**
   * Idempotent: the first call for a held order marks it paid; repeats and unknown refs do nothing.
   * Everything up to text 2 happens before the first await, so the booking is paid as soon as this is called.
   */
  async function onPaid(ref, source) {
    const order = findOrder(ref);
    if (!order || order.status !== 'held' || store.paidEvents.has(ref)) return false;
    store.paidEvents.add(ref);
    setOrderStatus(ref, 'paid');
    order.paid_with = source;

    const payer = (order.payer || 'Daniel').split(' ')[0];
    emit(store.activeCall?.id ?? null, 'system', {
      system: 'Payment', action: 'paid', ok: true, summary: `✓ ${payer} paid for ${ref} (${source})`,
    });
    // The call hears it at once; text 2 (an email when TEXTS=email) can take a few seconds.
    try {
      store.activeCall?.session?.notify?.(`${payer} has paid for booking ${ref}`);
    } catch (err) {
      console.error(`[payment] the call was not told that ${ref} is paid: ${err.message}`);
    }

    // Text 2 goes to the traveller's number on file, with the same trip page link as text 1. When texts go by email,
    // the same message goes as the designed booked email, to the address on file for that number.
    const member = findMember(order.member_id);
    try {
      const link = member ? tripLink(order) : '';
      const byEmail = (process.env.TEXTS || 'email').trim().toLowerCase() === 'email';
      if (member && emails?.bookedEmail && byEmail && member.email) {
        const mail = emails.bookedEmail({ order, profile: member, link });
        await messages.sendEmail(member.email, mail.subject, mail.html, mail.text);
      } else if (member) {
        await messages.sendSms(member.phone, texts.bookedSms(order, member, link));
      }
    } catch (err) {
      console.error(`[payment] text 2 for ${ref} not sent: ${err.message}`);   // the booking is still paid
    }
    return true;
  }

  /** The held or paid booking behind a live trip page code, else null. */
  function bookingFor(code) {
    const page = store.pages.get(code);
    if (!page || (page.expires != null && Date.now() > new Date(page.expires).getTime())) return null;
    const order = page.ref ? findOrder(page.ref) : null;
    return order?.status === 'held' || order?.status === 'paid' ? order : null;
  }

  /**
   * /pay/<code>, the one pay link (the Pay button on the trip page, and the pay email). GET: the pay page while the
   * booking is held; once it's paid, "Payment successful", which goes back to the trip page by itself. POST method=<id>:
   * pays, then redirects back to GET, so a reload can't pay twice. An unknown or expired code, a booking that isn't
   * held or paid, or another HTTP method: notFound().
   */
  async function payRoute(req, res, code, notFound) {
    const order = bookingFor(code);
    if (!order || (req.method !== 'GET' && req.method !== 'POST')) return notFound();
    if (req.method === 'GET') {
      const render = order.status === 'paid' ? renderPaidPage : renderPayPage;
      return sendPage(res, 200, (nonce) => render({ order, code, nonce }));
    }
    const form = await readForm(req);
    if (!form) return res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', ...PRIVATE }).end('Too large');
    if (order.status === 'held') {
      const label = methodLabel(form.get('method'));
      if (!label) return sendPage(res, 400, (nonce) => renderPayPage({ order, code, nonce, error: 'Choose how to pay first.' }));
      // Paid before this line returns; text 2 follows without holding up the payer's page.
      onPaid(order.ref, label).catch((err) => console.error(`[payment] ${order.ref}: ${err.message}`));
    }
    res.writeHead(303, { Location: `/pay/${encodeURIComponent(code)}`, ...PRIVATE }).end();
  }

  return { onPaid, payRoute };
}
