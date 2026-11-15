// Email wording. Mail apps remove style sheets and scripts, so: inline styles only, one column,
// text of 20 px or more, high contrast, text as text (no images). Colours follow Cathay's site.
// The one designed email: the booking after payment (bookedEmail). Other messages are texts sent by email (messages.js).
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
