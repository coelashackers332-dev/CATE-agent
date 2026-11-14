// The view-only trip page (GET /v/:code). Rendered on every open from the booking's current state:
// options (none chosen yet, or held) -> confirmed + needs card (paid) -> ended.
// It only shows. No forms, nothing loaded from other sites. A held booking can carry one Pay link, and
// while the booking can still change, one small script re-reads this same page so it follows the call.
// It prints name, flights and needs only: never phone, email, member number or passport.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escape any value put into a page or email. */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Segment times are local airport times with no zone ("2027-02-19T11:40"), so they are read as
// text. Date.UTC is used only to find the weekday.
function parts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(String(iso ?? ''));
  if (!m) return null;
  const month = Number(m[2]) - 1;
  if (month > 11) return null;
  return { weekday: new Date(Date.UTC(Number(m[1]), month, Number(m[3]))).getUTCDay(), day: Number(m[3]), month, time: m[4] ?? '' };
}

/** "Friday 19 February", or "Fri 19 Feb" with short = true. Returns the input if it is not a date. */
export function fmtDay(iso, short = false) {
  const p = parts(iso);
  if (!p) return String(iso ?? '');
  const cut = (s) => (short ? s.slice(0, 3) : s);
  return `${cut(DAYS[p.weekday])} ${p.day} ${cut(MONTHS[p.month])}`;
}
/** "11:40" */
export const fmtTime = (iso) => parts(iso)?.time ?? '';
/** "HKD 8,420" */
export const money = (n) => `HKD ${Number(n).toLocaleString('en-US')}`;

/**
 * Needs card wording per IATA wheelchair code: what staff should do, and what the traveller can do.
 * Same meaning as the fixed table behind set_assistance (STACK.md section 4).
 */
export const NEEDS = {
  WCHR: { short: 'Wheelchair from check-in to the gate', detail: 'I can walk short distances and climb stairs.' },
  WCHS: { short: 'Wheelchair from check-in to the aircraft door', detail: 'I can walk to my seat, but I cannot climb stairs.' },
  WCHC: { short: 'Wheelchair all the way to my seat', detail: 'I cannot walk. Please help me to my seat.' },
};
/** "Wheelchair from check-in to the gate" for a known code, else "Special assistance". */
export const needWords = (code) => NEEDS[code]?.short ?? 'Special assistance';

/** Where the trip goes and starts, in words. The return segment's city is the starting city. */
export const tripCity = (t) => t?.out?.city ?? t?.out?.to ?? '';
export const homeCity = (t) => t?.back?.city ?? t?.out?.from ?? '';

const firstName = (full) => String(full ?? '').trim().split(/\s+/)[0];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

function passengerName(order, profile) {
  if (order?.passenger) return order.passenger;
  const n = profile?.name;
  if (typeof n === 'string') return n;
  return n ? `${n.family ?? ''} ${n.given ?? ''}`.trim() : '';
}

// ---------------------------------------------------------------------------------------------
// The whole look is this one block. To switch to design/pages/trip-page-glass.html or
// trip-page-simple.html, replace this string and keep the class names.
// ---------------------------------------------------------------------------------------------
const CSS = `
  :root {
    --paper: #ffffff; --ground: #eef3f2; --ink: #172524; --muted: #46595a; --line: #c9d6d4;
    --jade: #01484b; --jade-2: #00787a; --mint: #e4f2ef; --sun: #f5b83d; --sun-ink: #3d2a00;
    --go: #01484b; --go-ink: #ffffff;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang HK", "Microsoft JhengHei", "Noto Sans TC", sans-serif;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #0f1d1d; --ground: #081414; --ink: #eef5f4; --muted: #a9bdbb; --line: #2b4443; --jade-2: #5cc3bd; --mint: #163332; --go: #5cc3bd; --go-ink: #06201f; }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--ground); color: var(--ink); font-family: var(--sans); font-size: 20px; line-height: 1.45; }
  p, h1, h2, ol, dl, dd { margin: 0; }
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
  .soft { color: var(--muted); }
  .opts { list-style: none; padding: 0; display: grid; gap: 12px; }
  .opt { display: grid; grid-template-columns: 56px 1fr; gap: 0 14px; padding: 14px 16px 14px 12px; border: 2px solid var(--line); border-radius: 16px; }
  .opt > :not(.n) { grid-column: 2; min-width: 0; }
  .opt .n { grid-row: 1 / span 6; font-size: 44px; line-height: 1; font-weight: 700; color: var(--jade-2); text-align: center; padding-top: 2px; }
  .opt .when { font-size: 24px; font-weight: 700; }
  .opt .time { font-size: 32px; line-height: 1.15; font-weight: 700; font-variant-numeric: tabular-nums; }
  .opt .fare { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .opt.held { border-color: var(--jade-2); background: var(--mint); }
  .flag { display: inline-block; margin: 6px 0 2px; background: var(--sun); color: var(--sun-ink); font-weight: 700; font-size: 17px; padding: 2px 10px; border-radius: 6px; }
  .say { margin-top: 16px; font-size: 22px; }
  .leg { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; align-items: baseline; }
  .leg + .leg { margin-top: 18px; }
  .leg .dir { font-size: 17px; color: var(--muted); grid-column: 1 / -1; }
  .leg .day { font-size: 24px; font-weight: 700; grid-column: 1 / -1; }
  .leg .t { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.15; }
  .facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; }
  .facts dt { color: var(--muted); }
  .facts dd { font-weight: 700; overflow-wrap: anywhere; }
  .status { display: flex; gap: 14px; align-items: flex-start; background: var(--mint); border-radius: 16px; padding: 16px; }
  .dot { flex: none; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 22px; background: var(--sun); color: var(--sun-ink); }
  .status b { display: block; font-size: 24px; line-height: 1.2; margin-bottom: 4px; }
  .pay { display: block; margin-top: 16px; background: var(--go); color: var(--go-ink); font-size: 26px; font-weight: 700; line-height: 1.3; text-align: center; text-decoration: none; padding: 18px 20px; border-radius: 14px; }
  .pay:focus-visible { outline: 3px solid var(--sun); outline-offset: 3px; }
  .paynote { margin-top: 10px; font-size: 17px; }
  .show { font-size: 22px; font-weight: 700; margin-bottom: 12px; }
  .tag { position: relative; background: var(--jade); color: #fff; border-radius: 22px; padding: 46px 22px 0; }
  .tag::before { content: ""; position: absolute; top: 16px; left: 50%; width: 18px; height: 18px; margin-left: -9px; border-radius: 50%; background: var(--paper); }
  .need + .need { margin-top: 18px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.22); }
  .need .en { font-size: 26px; line-height: 1.25; font-weight: 700; }
  .need .more { font-size: 22px; margin-top: 4px; color: #d9ecea; }
  .stub { margin: 24px -22px 0; padding: 18px 22px 20px; border-top: 3px dashed rgba(255,255,255,.45); display: grid; grid-template-columns: auto 1fr; gap: 4px 18px; align-items: center; }
  .code { grid-row: span 3; background: var(--sun); color: var(--sun-ink); font-size: 32px; font-weight: 800; letter-spacing: .04em; padding: 10px 14px; border-radius: 10px; line-height: 1.1; text-align: center; }
  .stub .k { display: block; font-size: 15px; color: #bcdcd8; }
  .stub .v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .ended p + p { margin-top: 12px; }
  .safe { padding: 18px 20px 24px; background: var(--ground); font-size: 17px; color: var(--muted); }
  .safe b { color: var(--ink); }
  .safe p + p { margin-top: 8px; }
`;

const SAFE = '<b>This link only shows your trip.</b> Cathay never asks for passwords or card numbers here.';

/** A short fingerprint of what a page shows, so an open page can tell when the booking has changed. */
function version(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Pages that can still change keep themselves in step with the call: when the version on the server
// differs, the page reloads. It reads its own address only; nothing is sent or loaded from elsewhere.
// shortcut: re-reads the whole page every 3 seconds, fine during a call; give it a small version route if pages stay open for hours.
const LIVE = `
<script>
setInterval(async () => {
  try {
    const r = await fetch(location.href, { cache: 'no-store' });
    const v = /<html[^>]* data-v="([^"]*)"/.exec(await r.text());
    if (r.ok && (v ? v[1] : '') !== document.documentElement.dataset.v) { scrollTo(0, 0); location.reload(); }
  } catch {}
}, 3000);
</script>`;

function shell(title, body, live = false) {
  return `<!doctype html>
<html lang="en"${live ? ` data-v="${version(body)}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="page">
${body}
</main>${live ? LIVE : ''}
</body>
</html>`;
}

const top = (h1, lede) => `<header class="top">
  <p class="brand"><b>Cathay</b> CATE</p>
  <h1>${esc(h1)}</h1>${lede ? `\n  <p class="lede">${esc(lede)}</p>` : ''}
</header>`;

const footer = (fares = true) => `<footer class="safe">
  <p>${SAFE}</p>${fares ? '\n  <p>Prototype: illustrative fares and sample flights.</p>' : ''}
</footer>`;

function leg(dir, seg, fromCity) {
  if (!seg) return '';
  const nextDay = String(seg.arr ?? '').slice(0, 10) !== String(seg.dep ?? '').slice(0, 10);
  const via = seg.stops?.length ? `, via ${seg.stops.join(', ')}` : '';
  return `<div class="leg">
  <span class="dir">${esc(dir)} · flight ${esc(seg.flight)}${esc(via)}</span>
  <span class="day">${esc(fmtDay(seg.dep))}</span>
  <span class="t">${esc(fmtTime(seg.dep))}</span><span>${esc(fromCity || seg.from)}</span>
  <span class="t">${esc(fmtTime(seg.arr))}</span><span>${esc(seg.city ?? seg.to)}${nextDay ? `, ${esc(fmtDay(seg.arr))}` : ''}</span>
</div>`;
}

/** He pays himself when the order names no other payer. */
const paysHimself = (o) => !o?.payer || String(o.payer).toLowerCase() === String(o.passenger ?? '').toLowerCase();

function optionsState(page, order, payUrl) {
  const options = page.options ?? [];
  const held = order?.status === 'held' ? order : null;
  // Only a web address, or a path on this site, can go behind the Pay button.
  const payHref = held && /^(https?:\/\/|\/(?![/\\]))/i.test(payUrl ?? '') ? payUrl : null;
  const other = held && !paysHimself(held) ? firstName(held.payer) : '';
  // Paying by button and paying through the call stay open together: nobody is asked to choose first.
  const how = payHref
    ? (other ? 'You can also pay yourself with the button below.' : 'The button below opens the secure payment page.')
    : 'This page will show your booking as soon as it is paid. Nobody will ask you for card details.';
  const city = tripCity(held ?? options[0]);
  const backs = new Set(options.map((o) => o.back?.dep));
  const sameBack = options.length > 0 && backs.size === 1 && options[0].back;

  const items = options.map((o) => {
    const isHeld = held && String(o.id) === String(held.option_id);
    return `<li class="opt${isHeld ? ' held' : ''}">
  <span class="n">${esc(o.id)}</span>
  ${isHeld ? '<span><span class="flag">Held for you</span></span>' : ''}
  <span class="when">${esc(fmtDay(o.out?.dep))}</span>
  <span><span class="time">${esc(fmtTime(o.out?.dep))}</span> <span class="soft">lands ${esc(fmtTime(o.out?.arr))}</span></span>
  ${o.note ? `<span class="soft">${esc(cap(o.note))}</span>` : ''}
  ${sameBack ? '' : `<span class="soft">Back ${esc(fmtDay(o.back?.dep))}, ${esc(fmtTime(o.back?.dep))}</span>`}
  <span class="fare">${esc(money(o.fare_hkd))}</span>
</li>`;
  }).join('\n');

  const status = held ? `<div class="sec">
  <div class="status">
    <span class="dot" aria-hidden="true">…</span>
    <p><b>${other ? `Waiting for ${esc(other)} to pay` : payHref ? 'Pay to confirm your booking' : 'Waiting for payment'}</b>Option ${esc(held.option_id)} is held under booking reference ${esc(held.ref)}. ${how}</p>
  </div>${payHref ? `
  <a class="pay" href="${esc(payHref)}">Pay ${esc(money(held.fare_hkd))}</a>
  <p class="soft paynote">Test payment for this prototype. No real money moves.</p>` : ''}
</div>` : '';

  const list = options.length
    ? `<ol class="opts">\n${items}\n</ol>${held ? '' : '\n<p class="say">To choose, say the option number on the call.</p>'}`
    : '<p>Your flight options will show here during your call.</p>';

  const back = sameBack
    ? `<p>${options.length > 1 ? 'All come back' : 'Coming back'} on <b>${esc(fmtDay(options[0].back.dep))}</b>, leaving ${esc(tripCity(options[0]))} at ${esc(fmtTime(options[0].back.dep))}.</p>`
    : '';

  return shell(`Your ${city} flights`, `${top(
    held ? `Your ${city} trip is held` : `Your ${city} flights`,
    held ? '' : 'The same flights CATE read to you on the call.',
  )}
${status}
<div class="sec">
${list}
</div>
<div class="sec">
  ${back}
  <p class="soft">Prices are for the return trip, per person. Illustrative fares. Times are local at each airport.</p>
</div>
${footer(false)}`, true);
}

function needsCard(order, profile) {
  const codes = order.ssr ?? [];
  const needs = codes.map((code) => `<div class="need">
  <p class="en">${esc(needWords(code))} · ${esc(code)}</p>${NEEDS[code] ? `\n  <p class="more">${esc(NEEDS[code].detail)}</p>` : ''}
</div>`);
  if (profile?.speech?.pace === 'slow') needs.push('<div class="need">\n  <p class="en">Please speak slowly.</p>\n</div>');
  if (!needs.length) return '';
  return `<div class="sec">
  <p class="show">At the airport, show this card to staff</p>
  <article class="tag" aria-label="Needs card for airport staff">
${needs.join('\n')}
    <div class="stub">
      ${codes.length ? `<span class="code">${codes.map(esc).join('<br>')}</span>` : '<span></span>'}
      <span><span class="k">Passenger</span><span class="v">${esc(passengerName(order, profile))}</span></span>
      <span><span class="k">Booking</span><span class="v">${esc(order.ref)}</span></span>
      <span><span class="k">Flight</span><span class="v">${esc(order.out?.flight)} ${esc(fmtDay(order.out?.dep, true))}</span></span>
    </div>
  </article>
</div>`;
}

function confirmedState(order, profile) {
  const city = tripCity(order);
  const help = (order.ssr ?? []).map(needWords).join('; ') || 'None requested';
  const fact = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '');
  return shell(`Your ${city} trip`, `${top(
    `You're booked to ${city}`,
    `${paysHimself(order) ? 'Paid' : `${firstName(order.payer)} paid`}. Booking reference ${order.ref}.`,
  )}
${needsCard(order, profile)}
<div class="sec">
  <h2>Your flights</h2>
  ${leg('Going', order.out, homeCity(order))}
  ${leg('Coming back', order.back, city)}
</div>
<div class="sec">
  <dl class="facts">
    ${fact('Passenger', passengerName(order, profile))}
    ${fact('Booking', order.ref)}
    ${fact('Seat', cap(order.seat))}
    ${fact('Meal', cap(order.meal))}
    ${fact('Help', help)}
    ${fact('Price', `${money(order.fare_hkd)} return (illustrative fare)`)}
  </dl>
</div>
${footer()}`);
}

function endedState(order) {
  // A paid booking's page also expires (the day after the trip); that is not a failed hold.
  const paid = order?.status === 'paid';
  return shell('CATE trip page', `${top(paid ? 'This trip page has ended' : 'This hold has ended')}
<div class="sec ended">
  ${paid ? '' : '<p>The flights were not paid for in time, so nothing was booked and nothing was charged.</p>'}
  <p>To book again, call CATE. You won't need to repeat your needs.</p>
</div>
${footer(false)}`);
}

/**
 * The trip page for one link, as a full HTML document.
 * @param {object} a
 * @param {object} a.page      store.pages entry: { member_id, options, ref, expires }
 * @param {object|null} a.order   the order for page.ref, if a hold exists
 * @param {object|null} a.profile member record or model-safe profile; only name and speech pace are read
 * @param {Date|number|string} [a.now]
 * @param {string|null} [a.payUrl]  payment page for a traveller who pays himself. While the booking is
 *                                  held, the page then shows one Pay button to it. The page still asks for nothing.
 */
export function renderTripPage({ page, order = null, profile = null, now = Date.now(), payUrl = null }) {
  if (!page) return notFoundPage();
  const expired = page.expires != null && new Date(now) > new Date(page.expires);
  if (expired || order?.status === 'ended') return endedState(order);
  if (order?.status === 'paid') return confirmedState(order, profile);
  return optionsState(page, order, payUrl);
}

/** The same page for `/`, unknown codes and anything else: it says nothing about any booking. */
export function notFoundPage() {
  return shell('Not found', `${top('Not found')}
<div class="sec">
  <p>There is nothing at this address.</p>
</div>`);
}
