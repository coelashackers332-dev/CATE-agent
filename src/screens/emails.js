// Email wording. Mail apps remove style sheets and scripts, so: inline styles only, one column,
// text of 20 px or more, high contrast, text as text (no images). Colours follow Cathay's site.
// There is no SMS: the traveller gets his trip link (tripEmail) and his booking (bookedEmail) by email.
import { esc, fmtDay, fmtTime, money, needWords, tripCity, homeCity, seatText, bagsText } from './trip.js';

const INK = '#2d2d2d', MUTED = '#595b5d', JADE = '#005d63', GO = '#2c4036';
const P = `margin:0 0 16px;font-size:20px;line-height:1.5;color:${INK};`;
const SAFE = 'This link only shows your trip. Cathay never asks for passwords or card numbers by email or text.';
const TEST = 'This is a prototype. Fares are illustrative.';
const webLink = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);   // only a web link can go behind a button
const firstName = (full) => String(full ?? '').trim().split(/\s+/)[0];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const para = (t) => `<p style="${P}">${esc(t)}</p>`;
const row = (k, v) => `<p style="${P}"><span style="color:${MUTED};">${esc(k)}</span><br><b>${esc(v)}</b></p>`;
const button = (url, label) => `<p style="margin:8px 0 24px;"><a href="${esc(url)}" style="display:block;background:${GO};color:#ffffff;font-size:24px;font-weight:bold;line-height:1.3;text-align:center;text-decoration:none;padding:18px 24px;border-radius:4px;">${esc(label)}</a></p>`;
const page = (h1, inner) => `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:Arial,Helvetica,sans-serif;color:${INK};">
<p style="margin:0 0 20px;font-size:20px;color:${JADE};"><b>Cathay</b> CATE</p>
<h1 style="margin:0 0 20px;font-size:30px;line-height:1.2;color:${INK};">${esc(h1)}</h1>
${inner}
</div>
</body>
</html>`;

/**
 * The pay request to the family payer.
 * @param {object} a
 * @param {object} a.order           a held order
 * @param {string} a.travellerName   who the flight is for
 * @param {string} a.payerName       who is asked to pay
 * @param {string|null} a.payUrl     checkout link, or null when payment is by SMS reply
 * @returns {{ subject: string, html: string, text: string }}
 */
export function payEmail({ order, travellerName, payerName, payUrl }) {
  const url = webLink(payUrl);
  const city = tripCity(order);
  const hello = firstName(payerName);
  const going = `${fmtDay(order.out?.dep)}, ${fmtTime(order.out?.dep)}, ${homeCity(order)} to ${city} (${order.out?.flight})`;
  const back = `${fmtDay(order.back?.dep)}, ${fmtTime(order.back?.dep)} (${order.back?.flight})`;
  const help = (order.ssr ?? []).map(needWords).join('; ');
  const fare = `${money(order.fare_hkd)} return`;
  const rows = [['Going', going], ['Coming back', back], ['Seat', order.seat], ['Help', help], ['Booking reference', order.ref], ['Price', fare]]
    .filter(([, v]) => v);

  const intro = `${travellerName} booked this trip by phone with CATE, Cathay's automated travel assistant, and asked us to send you the payment request. The flights are held and nothing is paid yet.`;
  const how = url ? 'To pay, use the Pay button below.' : 'To pay, reply PAY to the text message we sent you.';
  const test = "This is a prototype. The payment is a test payment standing in for Cathay's payment page, and no real money moves. The fare is illustrative.";
  const safe = "Cathay never asks for passwords or card numbers by email or text. If you weren't expecting this, you can ignore it and nothing is charged.";

  const subject = `Payment request: ${travellerName}'s Cathay flight to ${city} (${order.ref})`;

  const action = url
    ? button(url, `Pay ${money(order.fare_hkd)}`)
    : `<p style="margin:8px 0 24px;background:#f1f4f1;border-left:6px solid #367878;border-radius:4px;padding:18px 20px;font-size:24px;font-weight:bold;line-height:1.35;color:${INK};">Reply PAY to the text message we sent you.</p>`;

  const html = page(`${travellerName} asks you to pay for a flight to ${city}`, [
    para(`Hello ${hello},`), para(intro), ...rows.map(([k, v]) => row(k, v)), action, para(test), para(safe),
  ].join('\n'));

  const text = [
    `Hello ${hello},`,
    intro,
    rows.map(([k, v]) => `${k}: ${v}`).join('\n'),
    url ? `${how}\n${url}` : how,
    test,
    safe,
  ].join('\n\n');

  return { subject, html, text };
}

/**
 * The trip link and the flight options, sent to the traveller while he is on the call.
 * @param {{ options: object[], link: string, travellerName: string }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function tripEmail({ options, link, travellerName }) {
  const url = webLink(link);
  const city = tripCity(options[0]);
  const backs = new Set(options.map((o) => o.back?.dep));
  const back = backs.size === 1 && options[0]?.back ? `All come back on ${fmtDay(options[0].back.dep)}, leaving ${city} at ${fmtTime(options[0].back.dep)}.` : '';
  const items = options.map((o) => [
    `Option ${o.id}`,
    [`${fmtDay(o.out?.dep)}, ${fmtTime(o.out?.dep)}, ${money(o.fare_hkd)}`, o.note, !back && o.back && `back ${fmtDay(o.back.dep)}, ${fmtTime(o.back.dep)}`].filter(Boolean).join(', '),
  ]);
  const intro = 'These are the flights CATE found for you. Tell CATE on the phone which one you would like. Your trip page shows them in large print.';
  const fares = 'Illustrative fares. Prices are for the return trip, per person. Times are local at each airport.';
  const html = page(`Your flights to ${city}`, [
    para(`Hello ${travellerName},`), para(intro), ...items.map(([k, v]) => row(k, v)), back && para(back),
    url && button(url, 'Open your trip page'), para(fares), para(SAFE),
  ].filter(Boolean).join('\n'));
  const text = [`Hello ${travellerName},`, intro, items.map(([k, v]) => `${k}: ${v}`).join('\n'), back, url && `Your trip page: ${url}`, fares, SAFE]
    .filter(Boolean).join('\n\n');
  return { subject: `Your Cathay flight options to ${city}`, html, text };
}

/**
 * The booking, after payment: flights, wishes, and what to show airport staff.
 * @param {{ order: object, profile: object, link: string }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function bookedEmail({ order, profile, link }) {
  const url = webLink(link);
  const city = tripCity(order);
  const paid = !order.payer || String(order.payer).toLowerCase() === String(order.passenger ?? '').toLowerCase() ? 'Paid' : `${firstName(order.payer)} paid`;
  const needs = (order.ssr ?? []).map((c) => `${needWords(c)} (${c})`);
  if (profile?.speech?.pace === 'slow') needs.push('Please speak slowly');
  const rows = [
    ['Passenger', order.passenger],
    ['Going', `${fmtDay(order.out?.dep)}, ${fmtTime(order.out?.dep)}, ${homeCity(order)} to ${city}, flight ${order.out?.flight}`],
    ['Coming back', `${fmtDay(order.back?.dep)}, ${fmtTime(order.back?.dep)}, flight ${order.back?.flight}`],
    ['Seat', seatText(order)],
    ['Meal', order.meal && `${cap(order.meal)}`],
    ['Extra baggage', bagsText(order)],
    ['Noted for staff', (order.requests ?? []).join('; ')],
    ['Passport', order.passport],
    ['Price', order.total_hkd != null ? `${money(order.total_hkd)} return` : ''],
  ].filter(([, v]) => v);
  const lede = `${paid}. Your booking reference is ${order.ref}.`;
  const show = 'At the airport, show this to staff:';
  const html = page(`You're booked to ${city}`, [
    para(lede), ...rows.map(([k, v]) => row(k, v)),
    needs.length && `<div style="margin:8px 0 24px;background:${JADE};border-radius:8px;padding:20px;color:#ffffff;"><p style="margin:0 0 10px;font-size:20px;">${esc(show)}</p>${needs.map((n) => `<p style="margin:0 0 8px;font-size:24px;font-weight:bold;line-height:1.3;">${esc(n)}</p>`).join('')}</div>`,
    url && button(url, 'Open your needs card'), para(TEST), para(SAFE),
  ].filter(Boolean).join('\n'));
  const text = [lede, rows.map(([k, v]) => `${k}: ${v}`).join('\n'), needs.length && `${show}\n${needs.join('\n')}`, url && `Your needs card and trip: ${url}`, TEST, SAFE]
    .filter(Boolean).join('\n\n');
  return { subject: `Booked: your Cathay flight to ${city} (${order.ref})`, html, text };
}
