// SMS wording. Rules (STACK.md section 2): text only, plain characters only (one curly quote or long
// dash turns the whole message into 70-character parts), and every detail is in the text itself:
// the link is an extra.
import { fmtDay, fmtTime, needWords, tripCity, homeCity } from './trip.js';

const MAX_TEXT_1 = 306; // 2 SMS parts of 153 characters

/** Force plain ASCII: seed data or a city name could carry an accent, a curly quote or a long dash. */
function plain(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E\n]|`/g, ''); // a backtick is ASCII but not in the SMS alphabet
}

const hkd = (n) => `HKD ${Number(n)}`;
const when = (seg) => `${fmtDay(seg?.dep, true)} ${fmtTime(seg?.dep)}`.trim();
const lower = (s) => String(s ?? '').toLowerCase();

/** Text 1, to the traveller during the call: the options in short form + the trip-page link. */
export function optionsSms(options, link) {
  const lines = options.map((o) => {
    const via = o.note ? ` ${o.note.split(',')[0].trim()}` : ''; // "via Tokyo, 4.5 hours longer" -> "via Tokyo"
    return `${o.id}) ${when(o.out)}${via}, ${hkd(o.fare_hkd)}`;
  });
  const backs = [...new Set(options.map((o) => fmtDay(o.back?.dep, true)))];
  const head = `Cathay CATE: your ${tripCity(options[0])} flights\n${lines.join('\n')}\n${backs.length === 1 ? `Back ${backs[0]}. ` : ''}`;
  // Longest version that fits in 2 parts. With a very long address the link goes before any detail does.
  const tails = [
    `Big-text view: ${link}\nThis link only shows your trip. Cathay never asks for card numbers here.`,
    `Big-text view: ${link}\nView only. Cathay never asks for card numbers.`,
    'Cathay never asks for card numbers by text.',
  ];
  const texts = tails.map((t) => plain(head + t));
  return texts.find((t) => t.length <= MAX_TEXT_1) ?? texts.at(-1).slice(0, MAX_TEXT_1);
}

/** Text 2, to the traveller after payment: the booking and the needs card in words, so it works with no data abroad. */
export function bookedSms(order, profile, link) {
  const needs = (order.ssr ?? []).map((c) => `${needWords(c)}, ${c}`);
  if (profile?.speech?.pace === 'slow') needs.push('Please speak slowly');
  // Seat and meal are on the trip page; leaving them out keeps this text within 2 parts with a long link.
  return plain([
    `Cathay CATE: booked. Ref ${order.ref}, ${order.passenger}.`,
    `${order.out.flight} ${when(order.out)} ${homeCity(order)} to ${tripCity(order)}.`,
    `Back ${order.back.flight} ${when(order.back)}.`,
    needs.length && `Show staff: ${needs.join('. ')}.`,
    `Trip: ${link}`,
  ].filter(Boolean).join('\n'));
}

/** Pay request to the family payer (PAYMENT=sms): they answer PAY to this text. */
export function payRequestSms(order, travellerName) {
  return plain([
    `Cathay CATE: ${travellerName} asks you to pay for a flight.`,
    `${homeCity(order)} to ${tripCity(order)}, ${when(order.out)}, back ${fmtDay(order.back?.dep, true)}. Ref ${order.ref}.`,
    `${hkd(order.fare_hkd)} return (test payment, illustrative fare).`,
    'Reply PAY to pay. Cathay never asks for card numbers by text.',
  ].join('\n'));
}
