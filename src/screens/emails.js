// Email wording. Mail apps remove style sheets and scripts, so: inline styles only, one column,
// text of 20 px or more, high contrast, text as text (no images).
import { esc, fmtDay, fmtTime, money, needWords, tripCity, homeCity } from './trip.js';

const P = 'margin:0 0 16px;font-size:20px;line-height:1.5;color:#172524;';

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
  const url = /^https?:\/\//i.test(payUrl ?? '') ? payUrl : null; // only a web link can go behind the button
  const city = tripCity(order);
  const hello = String(payerName ?? '').trim().split(/\s+/)[0];
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
    ? `<p style="margin:8px 0 24px;"><a href="${esc(url)}" style="display:block;background:#01484b;color:#ffffff;font-size:24px;font-weight:bold;line-height:1.3;text-align:center;text-decoration:none;padding:18px 24px;border-radius:12px;">Pay ${esc(money(order.fare_hkd))}</a></p>`
    : `<p style="margin:8px 0 24px;background:#e4f2ef;border-radius:12px;padding:18px 20px;font-size:24px;font-weight:bold;line-height:1.35;color:#172524;">Reply PAY to the text message we sent you.</p>`;

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:Arial,Helvetica,sans-serif;color:#172524;">
<p style="margin:0 0 20px;font-size:20px;color:#01484b;"><b>Cathay</b> CATE</p>
<h1 style="margin:0 0 20px;font-size:30px;line-height:1.2;color:#172524;">${esc(travellerName)} asks you to pay for a flight to ${esc(city)}</h1>
<p style="${P}">Hello ${esc(hello)},</p>
<p style="${P}">${esc(intro)}</p>
${rows.map(([k, v]) => `<p style="${P}"><span style="color:#46595a;">${esc(k)}</span><br><b>${esc(v)}</b></p>`).join('\n')}
${action}
<p style="${P}">${esc(test)}</p>
<p style="${P}">${esc(safe)}</p>
</div>
</body>
</html>`;

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
