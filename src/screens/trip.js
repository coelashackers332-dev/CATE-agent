// The trip page (GET /v/:code). Rendered on every open from the booking's current state:
// options (none chosen yet, or held) -> confirmed + needs card (paid) -> ended.
// Nothing is typed here and nothing is loaded from other sites. A held booking can carry one Pay link.
// While his call is live, the options carry answer buttons (which flight, who pays): the same answers he
// can say aloud, posted to this page's own address. While the booking can still change, one small script
// re-reads this same page so it follows the call.
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
/** "21A", "Window, front of the cabin", "Aisle": the value next to a "Seat" label. */
export const seatText = (o) => (o.seat_number ? o.seat_number : [cap(o.seat), o.seat_area && `${o.seat_area} of the cabin`].filter(Boolean).join(', '));
/** "1 extra checked bag", or '' for none. */
export const bagsText = (o) => (o.extra_bags ? `${o.extra_bags} extra checked bag${o.extra_bags === 1 ? '' : 's'}` : '');

function passengerName(order, profile) {
  if (order?.passenger) return order.passenger;
  const n = profile?.name;
  if (typeof n === 'string') return n;
  return n ? `${n.family ?? ''} ${n.given ?? ''}`.trim() : '';
}

// ---------------------------------------------------------------------------------------------
// The whole look is this one block: Cathay jade behind, frosted white glass panes in front (iOS style).
// Every word sits on a near-white pane at high contrast; the needs card stays solid for airport staff.
// Panes go solid when the phone asks for less transparency or more contrast. Cathay Sans is not loaded.
// ---------------------------------------------------------------------------------------------
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
  p, h1, h2, ol, dl, dd, form { margin: 0; }
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
  h2 { font-size: 24px; line-height: 1.2; font-weight: 700; margin-bottom: 14px; }
  .soft { color: var(--muted); }

  /* Flight options */
  .opts { list-style: none; padding: 0; display: grid; gap: 12px; }
  .opt { display: grid; grid-template-columns: 52px 1fr; gap: 0 14px; padding: 16px 16px 16px 12px; border: 1px solid var(--line-2); border-radius: 16px; background: rgba(255, 255, 255, .6); }
  @media (prefers-color-scheme: dark) { .opt { background: rgba(255, 255, 255, .04); } }
  .opt > :not(.n) { grid-column: 2; min-width: 0; }
  .opt .n { grid-row: 1 / span 6; font-size: 40px; line-height: 1; font-weight: 700; color: var(--jade); text-align: center; padding-top: 2px; }
  @media (prefers-color-scheme: dark) { .opt .n { color: var(--accent); } }
  .opt .when { font-size: 22px; font-weight: 700; }
  .opt .time { font-size: 32px; line-height: 1.15; font-weight: 700; font-variant-numeric: tabular-nums; }
  .opt .fare { margin-top: 6px; font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .opt.held { border: 2px solid var(--jade); background: rgba(255, 255, 255, .92); box-shadow: inset 6px 0 0 var(--jade); }
  @media (prefers-color-scheme: dark) { .opt.held { border-color: var(--accent); background: rgba(143, 208, 203, .10); box-shadow: inset 6px 0 0 var(--accent); } }
  .flag { display: inline-block; margin-bottom: 4px; background: var(--jade); color: #fff; font-weight: 700; font-size: 16px; padding: 2px 10px; border-radius: 6px; }
  .say { margin-top: 16px; font-size: 22px; }

  /* Booked */
  .leg { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; align-items: baseline; }
  .leg + .leg { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
  .leg .dir { font-size: 17px; color: var(--muted); grid-column: 1 / -1; }
  .leg .day { font-size: 22px; font-weight: 700; grid-column: 1 / -1; }
  .leg .t { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.15; }
  .facts { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; }
  .facts dt { color: var(--muted); }
  .facts dd { font-weight: 700; overflow-wrap: anywhere; }

  /* Waiting notice, and the Pay button */
  .status { background: var(--soft); border-left: 6px solid var(--accent); border-radius: 10px; padding: 14px 16px; }
  .dot { display: none; }
  .status b { display: block; font-size: 22px; line-height: 1.25; margin-bottom: 4px; }
  .pay { display: block; margin-top: 18px; min-height: 64px; background: var(--go); color: var(--go-ink); font-size: 24px; font-weight: 700; line-height: 1.3; text-align: center; text-decoration: none; padding: 17px 20px; border-radius: 14px; box-shadow: 0 1px 0 rgba(255, 255, 255, .18) inset, 0 8px 18px rgba(0, 37, 39, .25); }
  .pay:hover { background: var(--go-hover); }
  .pay:active, .pick:active { transform: scale(.98); }
  .pay:focus-visible, .pick:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  .paynote { margin-top: 10px; font-size: 17px; }

  /* Check your booking: the summary before the hold */
  .sum { display: grid; gap: 12px; margin: 0; }
  .sum dt { font-size: 14px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
  .sum dd { margin: 2px 0 0; font-size: 21px; font-weight: 700; line-height: 1.3; font-variant-numeric: tabular-nums; }
  .check .total { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-top: 16px; padding-top: 14px; border-top: 2px dashed var(--line-2); font-size: 19px; }
  .check .total b { font-size: 30px; color: var(--jade); font-variant-numeric: tabular-nums; }
  @media (prefers-color-scheme: dark) { .check .total b { color: var(--accent); } }
  .check .soft { margin-top: 10px; font-size: 17px; }

  /* Answer buttons: the same answers he can say on the call. Filled = an open question, outlined = a change */
  .pick { display: block; width: 100%; min-height: 64px; margin-top: 14px; padding: 14px 18px; border: 2px solid var(--go); border-radius: 14px; background: var(--go); color: var(--go-ink); font: 700 22px/1.3 var(--sans); cursor: pointer; -webkit-appearance: none; appearance: none; }
  .pick:hover { background: var(--go-hover); border-color: var(--go-hover); }
  .pick.alt { background: transparent; color: var(--go); }
  .pick.alt:hover { background: var(--soft); border-color: var(--go); }
  .opt .pick { grid-column: 1 / -1; }
  .who { margin-top: 18px; }

  /* Needs card: solid jade, for staff at a counter */
  .show { font-size: 22px; font-weight: 700; margin-bottom: 12px; }
  .tag { position: relative; background: var(--jade); color: #fff; border-radius: 16px; padding: 44px 22px 0; }
  .tag::before { content: ""; position: absolute; top: 16px; left: 50%; width: 16px; height: 16px; margin-left: -8px; border-radius: 50%; background: #e9f1f0; }
  .need + .need { margin-top: 18px; padding-top: 18px; border-top: 1px solid rgba(255, 255, 255, .25); }
  .need .en { font-size: 26px; line-height: 1.25; font-weight: 700; }
  .need .more { font-size: 22px; margin-top: 4px; color: #d9e9e8; }
  .stub { margin: 24px -22px 0; padding: 18px 22px 20px; border-top: 2px dashed rgba(255, 255, 255, .5); display: grid; grid-template-columns: auto 1fr; gap: 4px 18px; align-items: center; }
  .code { grid-row: span 3; background: #fff; color: #005d63; font-size: 32px; font-weight: 800; letter-spacing: .04em; padding: 10px 14px; border-radius: 8px; line-height: 1.1; text-align: center; }
  .stub .k { display: block; font-size: 15px; color: #cfe3e2; }
  .stub .v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: break-word; }
  @media (max-width: 400px) { .stub { grid-template-columns: 1fr; gap: 8px; } .code { grid-row: auto; justify-self: start; margin-bottom: 6px; } }

  .ended p + p { margin-top: 12px; }
  /* The safety note sits on the jade, below the panes */
  .safe { padding: 6px 8px 0; font-size: 17px; color: var(--on-jade-soft); }
  .safe b { color: var(--on-jade); }
  .safe p + p { margin-top: 8px; }

  /* Solid panes when the phone asks for less transparency or more contrast, or cannot blur */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { :root { --glass: rgba(255, 255, 255, .97); } }
  @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
    .sec { background: #fff; -webkit-backdrop-filter: none; backdrop-filter: none; }
    .opt { background: #fff; border-color: #5d7170; }
  }
  @media (prefers-color-scheme: dark) and ((prefers-reduced-transparency: reduce) or (prefers-contrast: more)) {
    .sec, .opt { background: #0f1d1d; }
  }
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
// Every second, so a flight he chooses by voice shows on his phone while CATE is still saying it back.
// shortcut: re-reads the whole page every second, fine during a call on one server; give it a small version route if pages stay open for hours.
const LIVE = `
<script>
setInterval(async () => {
  try {
    const r = await fetch(location.href, { cache: 'no-store' });
    const v = /<html[^>]* data-v="([^"]*)"/.exec(await r.text());
    if (r.ok && (v ? v[1] : '') !== document.documentElement.dataset.v) { scrollTo(0, 0); location.reload(); }
  } catch {}
}, 1000);
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

/** The whole booking before the hold, so he can check it on screen instead of hearing it read out. Nothing is held yet. */
function checkCard(sum) {
  const row = (k, v) => (v ? `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>` : '');
  const fl = (seg) => `${fmtDay(seg?.dep, true)} · ${fmtTime(seg?.dep)} → ${fmtTime(seg?.arr)} · ${seg?.flight ?? ''}`;
  return `<section class="sec check" aria-label="Check your booking">
  <dl class="sum">
    ${row(`Going to ${sum.out?.city ?? sum.out?.to ?? ''}`, fl(sum.out))}
    ${row('Coming back', fl(sum.back))}
    ${row('Seat', cap(sum.seat))}
    ${row('Meal', cap(sum.meal))}
    ${row('Help at the airport', sum.help)}
    ${row('Extra bags', sum.extra_bags ? String(sum.extra_bags) : 'None')}
  </dl>
  <p class="total"><span>Total, return</span><b>${esc(money(sum.total_hkd))}</b></p>
  <p class="soft">Nothing is booked until you say yes on the call.</p>
</section>`;
}

function optionsState(page, order, payUrl, live) {
  const options = page.options ?? [];
  const held = order?.status === 'held' ? order : null;
  // While his call is live and nothing is held yet, the page also takes his answers by button.
  const ask = held ? null : live;
  const chosen = (ask?.choice != null && options.find((o) => String(o.id) === String(ask.choice))) || null;
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
    const flag = isHeld ? 'Held for you' : o === chosen ? 'Your choice' : '';
    return `<li class="opt${flag ? ' held' : ''}">
  <span class="n">${esc(o.id)}</span>
  ${flag ? `<span><span class="flag">${flag}</span></span>` : ''}
  <span class="when">${esc(fmtDay(o.out?.dep))}</span>
  <span class="time">${esc(fmtTime(o.out?.dep))}</span>
  <span class="soft">Arrives ${esc(fmtTime(o.out?.arr))}${String(o.out?.arr).slice(0, 10) > String(o.out?.dep).slice(0, 10) ? ' the next day' : ''}, ${esc(o.out?.city ?? o.out?.to)} time</span>
  ${o.note ? `<span class="soft">${esc(cap(o.note))}</span>` : ''}
  ${sameBack ? '' : `<span class="soft">Back ${esc(fmtDay(o.back?.dep))}, ${esc(fmtTime(o.back?.dep))}</span>`}
  <span class="fare">${esc(money(o.fare_hkd))}</span>${ask && o !== chosen ? `
  <button class="pick${chosen ? ' alt' : ''}" name="option" value="${esc(o.id)}">${chosen ? 'Change to' : 'Choose'} flight ${esc(o.id)}</button>` : ''}
</li>`;
  }).join('\n');

  // Who pays: asked once a flight is chosen, and only when a family payer is on file. An answer can still be changed.
  const family = esc(ask?.family ?? '');
  const pick = (value, text, alt = '') => `    <button class="pick${alt}" name="payer" value="${value}">${text}</button>`;
  const who = !chosen || !family ? ''
    : ask.payer === 'self' ? `    <p class="who"><b>You pay yourself.</b> After you say yes, the Pay button shows on this page.</p>\n${pick('family', `Ask ${family} to pay instead`, ' alt')}`
    : ask.payer === 'family' ? `    <p class="who"><b>${family} will be asked to pay.</b> After you say yes, CATE sends ${family} the payment link.</p>\n${pick('self', 'I pay myself instead', ' alt')}`
    : `    <h2 class="who">Who pays?</h2>\n${pick('self', 'I pay myself')}\n${pick('family', `Ask ${family} to pay`)}`;

  const status = chosen ? `<div class="sec">
  <div class="status">
    <p><b>You chose flight ${esc(chosen.id)}</b>CATE will read the booking back to you on the phone. Nothing is booked until you say yes.</p>
  </div>${who ? `\n  <form method="post">\n${who}\n  </form>` : ''}
</div>` : held ? `<div class="sec">
  <div class="status">
    <span class="dot" aria-hidden="true">…</span>
    <p><b>${other ? `Waiting for ${esc(other)} to pay` : payHref ? 'Pay to confirm your booking' : 'Waiting for payment'}</b>Option ${esc(held.option_id)} is held under booking reference ${esc(held.ref)}. ${how}</p>
  </div>${payHref ? `
  <a class="pay" href="${esc(payHref)}">Pay ${esc(money(held.due_hkd ?? held.total_hkd ?? held.fare_hkd))}</a>
  <p class="soft paynote">Test payment for this prototype. No real money moves.</p>` : ''}
</div>` : '';

  const say = !ask ? 'To choose, say the option number on the call.'
    : chosen ? 'To change, tap another flight, or say its number on the call.' : 'Tap a flight, or say its number on the call.';
  const list = options.length
    ? `${ask ? '<form method="post">\n' : ''}<ol class="opts">\n${items}\n</ol>${ask ? '\n</form>' : ''}${held ? '' : `\n<p class="say">${say}</p>`}`
    : '<p>Your flight options will show here during your call.</p>';

  const back = sameBack
    ? `<p>${options.length > 1 ? 'All come back' : 'Coming back'} on <b>${esc(fmtDay(options[0].back.dep))}</b>, leaving ${esc(tripCity(options[0]))} at ${esc(fmtTime(options[0].back.dep))}.</p>`
    : '';

  const check = !held && page.summary ? checkCard(page.summary) : '';
  return shell(`Your ${city} flights`, `${top(
    held ? `Your ${city} trip is held` : check ? 'Check your booking' : `Your ${city} flights`,
    held ? '' : check ? 'Is everything right? Say yes on the call to hold it.' : 'The same flights CATE read to you on the call.',
  )}
${check || status}
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
    ${fact('Seat', seatText(order))}
    ${fact('Meal', cap(order.meal))}
    ${fact('Help', help)}
    ${fact('Extra baggage', bagsText(order))}
    ${fact('Noted for staff', (order.requests ?? []).join('; '))}
    ${fact('Passport', order.passport)}
    ${fact('Price', `${money(order.total_hkd ?? order.fare_hkd)} return (illustrative fare)`)}
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
 * @param {object|null} [a.live]    pass it only while this page's call is live and nothing is held:
 *                                  { choice: option id chosen so far | null, payer: 'self' | 'family' | null,
 *                                    family: first name of the family payer on file, '' if none }.
 *                                  The page then carries answer buttons that POST `option=<id>` or
 *                                  `payer=self|family` to its own address. Without it the page only shows.
 */
export function renderTripPage({ page, order = null, profile = null, now = Date.now(), payUrl = null, live = null }) {
  if (!page) return notFoundPage();
  const expired = page.expires != null && new Date(now) > new Date(page.expires);
  if (expired || order?.status === 'ended') return endedState(order);
  if (order?.status === 'paid') return confirmedState(order, profile);
  return optionsState(page, order, payUrl, live);
}

/** The same page for `/`, unknown codes and anything else: it says nothing about any booking. */
export function notFoundPage() {
  return shell('Not found', `${top('Not found')}
<div class="sec">
  <p>There is nothing at this address.</p>
</div>`);
}
