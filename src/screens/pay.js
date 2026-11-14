// The pay page behind the one pay link, /pay/<trip page code>. Mr Wong reaches it from the Pay button on his trip page,
// or the family payer (Daniel) from the pay email. The payer picks how to pay and taps Pay; then the receipt.
// A demo: no money moves and nothing is asked for, so the page has no card fields at all.
// payment.js serves these pages and marks the booking paid; this file only draws them.
import { esc, money, fmtDay, tripCity } from './trip.js';

/** What the payer can choose, in this order. `id` is what the form sends back; `label` is shown and logged. */
export const METHODS = [
  { id: 'card', label: 'Credit or debit card', note: 'Visa, Mastercard, American Express' },
  { id: 'apple-pay', label: 'Apple Pay' },
  { id: 'google-pay', label: 'Google Pay' },
  { id: 'fps', label: 'FPS', note: 'Faster Payment System, 轉數快' },
  { id: 'payme', label: 'PayMe' },
  { id: 'alipayhk', label: 'AlipayHK' },
  { id: 'octopus', label: 'Octopus' },
];
/** The label for a method id from the form, or null if it isn't one of METHODS. */
export const methodLabel = (id) => METHODS.find((m) => m.id === id)?.label ?? null;

const nameCase = (s) => String(s ?? '').trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const firstName = (full) => String(full ?? '').trim().split(/\s+/)[0];
const sameName = (a, b) => String(a ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === String(b ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
/** True when the traveller pays for himself (Marvel's `self_pay` flag on the order, else the payer is the passenger). */
const paysHimself = (order) => order.self_pay ?? sameName(order.payer, order.passenger);

// Same colours, type and spacing as the trip page (src/screens/trip.js), so the two read as one site.
const CSS = `
  :root {
    --paper: #ffffff; --ground: #eef3f2; --ink: #172524; --muted: #46595a; --line: #c9d6d4;
    --jade: #01484b; --jade-2: #00787a; --mint: #e4f2ef; --sun: #f5b83d; --sun-ink: #3d2a00; --ok: #1d7a46;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang HK", "Microsoft JhengHei", "Noto Sans TC", sans-serif;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #0f1d1d; --ground: #081414; --ink: #eef5f4; --muted: #a9bdbb; --line: #2b4443; --jade-2: #5cc3bd; --mint: #163332; --ok: #5fd08f; }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--ground); color: var(--ink); font-family: var(--sans); font-size: 20px; line-height: 1.45; }
  p, h1, h2, dl, dd { margin: 0; }
  .page { max-width: 30rem; margin: 0 auto 40px; background: var(--paper); }
  @media (min-width: 560px) { .page { margin-top: 16px; border-radius: 24px; border: 1px solid var(--line); overflow: hidden; } }
  .top { background: var(--jade); color: #fff; padding: 18px 20px 22px; }
  .brand { font-size: 17px; margin-bottom: 14px; color: #d9ecea; }
  .brand b { color: #fff; }
  .top h1 { font-size: 32px; line-height: 1.15; font-weight: 700; text-wrap: balance; }
  .top .lede { margin-top: 8px; font-size: 20px; color: #d9ecea; }
  .sec { padding: 22px 20px; }
  .sec + .sec { border-top: 1px solid var(--line); }
  h2 { font-size: 24px; line-height: 1.2; margin-bottom: 12px; }
  .facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; }
  .facts dt { color: var(--muted); }
  .facts dd { font-weight: 700; overflow-wrap: anywhere; }
  .total { display: flex; justify-content: space-between; align-items: baseline; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
  .total b { font-size: 28px; font-variant-numeric: tabular-nums; }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  legend { padding: 0; }
  .methods { display: grid; gap: 10px; }
  .method { display: grid; grid-template-columns: 30px 1fr; gap: 0 12px; align-items: center; padding: 14px 16px; border: 2px solid var(--line); border-radius: 16px; cursor: pointer; }
  .method input { width: 26px; height: 26px; margin: 0; accent-color: var(--jade-2); }
  .method .name { font-size: 22px; font-weight: 700; }
  .method .note { grid-column: 2; font-size: 17px; color: var(--muted); }
  .method:has(input:checked) { border-color: var(--jade-2); background: var(--mint); }
  .method:has(input:focus-visible) { outline: 3px solid var(--sun); outline-offset: 2px; }
  .err { margin-bottom: 12px; background: var(--sun); color: var(--sun-ink); font-weight: 700; padding: 10px 14px; border-radius: 10px; }
  .btn { display: block; width: 100%; margin-top: 18px; padding: 18px 20px; border: 0; border-radius: 14px; background: var(--jade); color: #fff;
    font: inherit; font-size: 24px; font-weight: 700; line-height: 1.3; text-align: center; text-decoration: none; cursor: pointer; }
  .btn:disabled { opacity: .75; cursor: progress; }
  @media (prefers-color-scheme: dark) { .btn { background: var(--jade-2); color: #081414; } }
  .demo { margin-top: 12px; font-size: 17px; color: var(--muted); text-align: center; }
  .status { display: flex; gap: 14px; align-items: flex-start; background: var(--mint); border-radius: 16px; padding: 16px; }
  .dot { flex: none; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 22px; background: var(--ok); color: #fff; }
  .status b { display: block; font-size: 24px; line-height: 1.2; margin-bottom: 4px; }
  .next { margin-top: 16px; }
  .safe { padding: 18px 20px 24px; background: var(--ground); font-size: 17px; color: var(--muted); }
  .safe b { color: var(--ink); }
  .safe p + p { margin-top: 8px; }
`;

function shell(title, body, nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style nonce="${esc(nonce)}">${CSS}</style>
</head>
<body>
<main class="page">
${body}
</main>
</body>
</html>`;
}

const top = (h1, lede) => `<header class="top">
  <p class="brand"><b>Cathay</b> CATE</p>
  <h1>${esc(h1)}</h1>${lede ? `\n  <p class="lede">${esc(lede)}</p>` : ''}
</header>`;

const footer = `<footer class="safe">
  <p><b>Demo payment page: no money moves.</b> Cathay never asks for card numbers by text or phone.</p>
  <p>Prototype: illustrative fares and sample flights.</p>
</footer>`;

function tripFacts(order) {
  const fact = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '');
  const leg = (seg) => (seg ? `${fmtDay(seg.dep, true)}, flight ${seg.flight}` : '');
  return `<dl class="facts">
    ${fact('Passenger', nameCase(order.passenger))}
    ${fact('Going', leg(order.out))}
    ${fact('Coming back', leg(order.back))}
    ${fact('Booking', order.ref)}
  </dl>`;
}

/**
 * The page for a held booking: the trip, the amount, the methods and one Pay button. The form posts back to the
 * same address. `error` is shown above the methods (e.g. when none was chosen). `nonce` must match the response's CSP.
 */
export function renderPayPage({ order, code, nonce, error = '' }) {
  const city = tripCity(order);
  const whose = paysHimself(order) ? 'your' : `${nameCase(order.passenger)}'s`;
  const amount = money(order.fare_hkd);
  const methods = METHODS.map((m) => `<label class="method">
      <input type="radio" name="method" value="${esc(m.id)}" data-label="${esc(m.label)}" required>
      <span class="name">${esc(m.label)}</span>${m.note ? `\n      <span class="note">${esc(m.note)}</span>` : ''}
    </label>`).join('\n    ');
  return shell(`Pay for booking ${order.ref}`, `${top(`Pay for ${whose} trip${city ? ` to ${city}` : ''}`, `Booking reference ${order.ref}`)}
<div class="sec">
  ${tripFacts(order)}
  <p class="total"><span>To pay, return trip</span><b>${esc(amount)}</b></p>
</div>
<form class="sec payform" method="post" action="/pay/${esc(encodeURIComponent(code))}">
  <fieldset>
    <legend><h2>Choose how to pay</h2></legend>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
    <div class="methods">
    ${methods}
    </div>
  </fieldset>
  <button class="btn" type="submit">Pay ${esc(amount)}</button>
  <p class="demo">Demo: no card details needed, and no money moves.</p>
</form>
${footer}
<script nonce="${esc(nonce)}">
  // A short "paying" moment before the form is sent, and no second tap. Without JavaScript the form just posts.
  document.querySelector('.payform').addEventListener('submit', (e) => {
    const form = e.currentTarget;
    const picked = form.querySelector('input[name="method"]:checked');
    if (!picked) return;   // nothing chosen: the form posts and the server asks again
    e.preventDefault();
    if (form.dataset.sent) return;
    form.dataset.sent = '1';
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Paying with ' + picked.dataset.label + '\\u2026';
    setTimeout(() => form.submit(), 900);
  });
</script>`, nonce);
}

/** The receipt for a paid booking: who paid, how much, how, and the way back to the trip page. */
export function renderPaidPage({ order, code, nonce }) {
  const city = tripCity(order);
  const self = paysHimself(order);
  const how = METHODS.some((m) => m.label === order.paid_with) ? ` with ${order.paid_with}` : '';
  const traveller = nameCase(order.passenger);
  return shell(`Paid: booking ${order.ref}`, `${top('Payment received', self ? 'Thank you.' : `Thank you, ${firstName(order.payer) || 'payer'}.`)}
<div class="sec">
  <div class="status">
    <span class="dot" aria-hidden="true">✓</span>
    <p><b>${esc(money(order.fare_hkd))} paid</b>Paid${esc(how)} for ${self ? 'your' : `${esc(traveller)}'s`} trip${city ? ` to ${esc(city)}` : ''}. Booking reference ${esc(order.ref)}.</p>
  </div>
  <p class="next">${self ? 'Your booking confirmation is on its way to you.' : `${esc(traveller)} gets the booking confirmation.`}</p>
  <a class="btn" href="/v/${esc(encodeURIComponent(code))}">See the booking</a>
</div>
${footer}`, nonce);
}
