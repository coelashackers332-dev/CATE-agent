// The pay page behind the one pay link, /pay/<trip page code>. Mr Wong reaches it from the Pay button on his trip page,
// or the family payer (Daniel) from the pay email. It shows only the ways to pay and one Pay button: the trip itself
// is on the trip page. After the tap: "Payment successful", then back to the trip page by itself.
// A demo: no money moves and nothing is asked for, so the page has no card fields at all.
// The look is Cavell's (the trip page's CSS, from his design sheet for this page). payment.js serves these pages and
// marks the booking paid; this file only draws them.
import { esc, money } from './trip.js';

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

/** Seconds "Payment successful" shows before the page goes back to the trip page. */
export const BACK_AFTER_S = 3;

const firstName = (full) => String(full ?? '').trim().split(/\s+/)[0];
const sameName = (a, b) => String(a ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === String(b ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
/** True when the traveller pays for himself (Marvel's `self_pay` flag on the order, else the payer is the passenger). */
const paysHimself = (order) => order.self_pay ?? sameName(order.payer, order.passenger);

// Cavell's trip page CSS (his design sheet "One look for the trip page and the payment page"): the parts this page
// uses, with the same class names, plus the method cards from his payment page sketch, made dark-mode safe.
const CSS = `
  :root {
    --ink: #1f2a2a; --muted: #4f5c5c; --line: rgba(0, 93, 99, .14); --line-2: rgba(0, 93, 99, .28);
    --jade: #005d63; --jade-deep: #00393d; --accent: #367878; --go: #2c4036; --go-hover: #002527; --go-ink: #ffffff;
    --glass: rgba(255, 255, 255, .86); --glass-edge: rgba(255, 255, 255, .55); --soft: rgba(0, 93, 99, .07);
    --on-jade: #ffffff; --on-jade-soft: #cfe6e4;
    --sea: radial-gradient(120% 60% at 15% -10%, #2f8a8a 0%, transparent 60%),
           radial-gradient(90% 50% at 110% 30%, rgba(124, 192, 187, .45) 0%, transparent 65%),
           linear-gradient(180deg, #005d63 0%, #004a4f 55%, #00393d 100%);
    --sans: system-ui, -apple-system, "SF Pro Text", "Segoe UI", Roboto, "PingFang HK", "Microsoft JhengHei", "Noto Sans TC", sans-serif;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #eef3f2; --muted: #b9c6c5; --line: rgba(255, 255, 255, .12); --line-2: rgba(255, 255, 255, .24);
      --accent: #8fd0cb; --go: #8fd0cb; --go-hover: #b5e2de; --go-ink: #062224;
      --glass: rgba(10, 34, 36, .78); --glass-edge: rgba(255, 255, 255, .12); --soft: rgba(143, 208, 203, .10);
      --sea: radial-gradient(120% 60% at 15% -10%, #0d5a5c 0%, transparent 60%), linear-gradient(180deg, #00393d 0%, #001c1e 100%);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; background: #00393d; }
  body { margin: 0; min-height: 100vh; color: var(--ink); font-family: var(--sans); font-size: 20px; line-height: 1.45; }
  body::before { content: ""; position: fixed; inset: 0; z-index: -1; background: var(--sea); }
  p, h1, h2 { margin: 0; }
  .page { max-width: 30rem; margin: 0 auto; padding: 0 14px 36px; display: grid; gap: 14px; }

  /* The title sits straight on the jade, like an iPhone large title */
  .top { color: var(--on-jade); padding: 26px 8px 10px; }
  .brand { font-size: 16px; letter-spacing: .02em; margin-bottom: 18px; color: var(--on-jade-soft); }
  .brand b { color: var(--on-jade); }
  .top h1 { font-size: 34px; line-height: 1.12; font-weight: 700; letter-spacing: -.01em; text-wrap: balance; }
  .top .lede { margin-top: 10px; font-size: 20px; color: var(--on-jade-soft); }

  /* Frosted panes: glass at the edges, near-white behind every word */
  .sec { background: var(--glass); -webkit-backdrop-filter: blur(28px) saturate(180%); backdrop-filter: blur(28px) saturate(180%);
    border: 1px solid var(--glass-edge); border-radius: 22px; padding: 22px 20px;
    box-shadow: 0 1px 0 rgba(255, 255, 255, .7) inset, 0 18px 40px rgba(0, 30, 32, .28); }
  .soft { color: var(--muted); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  /* Notice, and the one main button */
  .status { background: var(--soft); border-left: 6px solid var(--accent); border-radius: 10px; padding: 14px 16px; }
  .status b { display: block; font-size: 22px; line-height: 1.25; margin-bottom: 4px; }
  .pay { display: block; width: 100%; margin-top: 18px; min-height: 64px; border: 0; background: var(--go); color: var(--go-ink); font: inherit;
    font-size: 24px; font-weight: 700; line-height: 1.3; text-align: center; text-decoration: none; padding: 17px 20px; border-radius: 14px;
    cursor: pointer; box-shadow: 0 1px 0 rgba(255, 255, 255, .18) inset, 0 8px 18px rgba(0, 37, 39, .25); }
  .pay:hover { background: var(--go-hover); }
  .pay:active { transform: scale(.98); }
  .pay:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  .paynote { margin-top: 10px; font-size: 17px; }

  /* Ways to pay: one big card each. The radio button is hidden; the card itself shows the choice. */
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  .err { margin-bottom: 12px; }
  .methods { display: grid; gap: 10px; }
  .method { position: relative; display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 10px 18px;
    border: 2px solid var(--line-2); border-radius: 14px; background: rgba(255, 255, 255, .7); cursor: pointer; }
  .method input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
  .method .name { display: block; font-size: 22px; font-weight: 700; line-height: 1.25; }
  .method .note { display: block; font-size: 17px; color: var(--muted); }
  .method small { display: none; margin-left: auto; font-size: 16px; color: var(--muted); }
  .method:has(input:checked), .method.on { border-color: var(--jade); box-shadow: inset 6px 0 0 var(--jade); background: #fff; }
  .method:has(input:checked) small, .method.on small { display: inline; }
  .method:has(input:focus-visible) { outline: 3px solid var(--accent); outline-offset: 3px; }
  @media (prefers-color-scheme: dark) {
    .method { background: rgba(255, 255, 255, .04); }
    .method:has(input:checked), .method.on { border-color: var(--accent); background: rgba(143, 208, 203, .10); box-shadow: inset 6px 0 0 var(--accent); }
  }

  /* Solid panes when the phone asks for less transparency or more contrast, or cannot blur */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { :root { --glass: rgba(255, 255, 255, .97); } }
  @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
    .sec { background: #fff; -webkit-backdrop-filter: none; backdrop-filter: none; }
    .method { background: #fff; border-color: #5d7170; }
  }
  @media (prefers-color-scheme: dark) and ((prefers-reduced-transparency: reduce) or (prefers-contrast: more)) {
    .sec, .method { background: #0f1d1d; }
  }
`;

/** The page around a body. `backTo`: an address this page goes to by itself after BACK_AFTER_S seconds. */
function shell(title, body, nonce, backTo = null) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">${backTo ? `\n<meta http-equiv="refresh" content="${BACK_AFTER_S};url=${esc(backTo)}">` : ''}
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

/**
 * The page for a held booking: only the ways to pay and one Pay button (with the amount on it). The form posts back
 * to the same address. `error` is shown above the ways to pay (e.g. when none was chosen). `nonce` must match the CSP.
 */
export function renderPayPage({ order, code, nonce, error = '' }) {
  const amount = money(order.due_hkd ?? order.total_hkd ?? order.fare_hkd);   // a changed booking: only the difference
  const methods = METHODS.map((m) => `<label class="method">
        <input type="radio" name="method" value="${esc(m.id)}" required>
        <span><span class="name">${esc(m.label)}</span>${m.note ? `<span class="note">${esc(m.note)}</span>` : ''}</span>
        <small>Selected</small>
      </label>`).join('\n      ');
  return shell('Choose how to pay', `${top('Choose how to pay')}
<form class="sec payform" method="post" action="/pay/${esc(encodeURIComponent(code))}">
  <fieldset>
    <legend class="sr">Ways to pay</legend>
    ${error ? `<p class="status err" role="alert"><b>${esc(error)}</b>Tap one of the ways to pay, then tap Pay.</p>` : ''}
    <div class="methods">
      ${methods}
    </div>
  </fieldset>
  <button class="pay" type="submit">Pay ${esc(amount)}</button>
  <p class="soft paynote">Test payment. No real money moves.</p>
</form>
<script nonce="${esc(nonce)}">
  // Shows the choice on phones without :has(), and says "Paying" after the tap. Without JavaScript the form still works.
  const form = document.querySelector('.payform');
  const cards = form.querySelectorAll('.method');
  form.addEventListener('change', () => cards.forEach((card) => card.classList.toggle('on', card.querySelector('input').checked)));
  form.addEventListener('submit', (e) => {
    if (form.dataset.sent) return e.preventDefault();   // one payment per tap
    form.dataset.sent = '1';
    form.querySelector('.pay').textContent = 'Paying\\u2026';
  });
</script>`, nonce);
}

/** After paying: "Payment successful", then back to the trip page by itself after BACK_AFTER_S seconds (or the button). */
export function renderPaidPage({ order, code, nonce }) {
  const self = paysHimself(order);
  const trip = `/v/${encodeURIComponent(code)}`;
  const how = METHODS.some((m) => m.label === order.paid_with) ? ` with ${order.paid_with}` : '';
  const thanks = self || !firstName(order.payer) ? 'Thank you.' : `Thank you, ${firstName(order.payer)}.`;
  return shell('Payment successful', `${top('Payment successful', `${money(order.due_hkd ?? order.total_hkd ?? order.fare_hkd)} paid${how}.`)}
<div class="sec">
  <p class="status" role="status"><b>${esc(thanks)}</b>Going back to the trip page in ${BACK_AFTER_S} seconds.</p>
  <a class="pay" href="${esc(trip)}">Back to the trip</a>
</div>`, nonce, trip);
}
