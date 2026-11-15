// MOCK Cathay systems: Membership, Orders and Schedule over the in-memory store.
// Same process as CATE, but behind a real HTTP boundary. Only src/cathay.js calls these routes.
// In production that adapter points at Cathay's own systems and this folder is not used.
import { randomInt } from 'node:crypto';
import { store, newRef, newToken, findMember, setOrderStatus } from '../store.js';
import { serviceKey } from './key.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_WORDS = new RegExp(`\\b(${MONTHS.flatMap((m) => [m, m.slice(0, 3)]).join('|')})\\b`, 'g');
const WHEELCHAIR_CODES = ['WCHR', 'WCHS', 'WCHC'];

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');
// One-time codes by member id: { code, expires }. One open code per member; a new one replaces it.
// shortcut: in memory, cleared only by a restart or a new code; fine for one call at a time.
const otps = new Map();
const OTP_TTL_MS = 10 * 60 * 1000;
const day = (dateTime) => dateTime.slice(0, 10);
/** When a trip starts. Seeded flown orders have `segments`; holds made by CATE have `out` / `back`. */
const tripStart = (order) => order.segments?.[0]?.date ?? order.out?.dep ?? '';
const newestFirst = (a, b) => tripStart(b).localeCompare(tripStart(a));
const ordersOf = (memberId) => store.orders.filter((o) => o.member_id === memberId).sort(newestFirst);

/**
 * "Where did you last fly with us?" passes if the answer names the city of the latest flown trip.
 * A month is optional, but if one is named it must be the right one.
 * ponytail: "may" the verb counts as the month May; fine for one seeded member, tighten with the real system.
 */
function answerMatches(order, answer) {
  const said = String(answer ?? '').toLowerCase();
  const city = (order.segments?.[0] ?? order.out).city.toLowerCase();
  if (!said.includes(city)) return false;
  const tripMonth = Number(tripStart(order).slice(5, 7));
  return (said.match(MONTH_WORDS) ?? []).every((word) => MONTHS.findIndex((m) => m.startsWith(word)) + 1 === tripMonth);
}

/**
 * What CATE may hand the voice model: no phone, no email, no delegate contacts, and of the passport
 * only that it is on file (the booking takes it from here, server side; it is never read out).
 */
const modelSafeProfile = (m) => ({
  name: `${m.name.family} ${m.name.given}`,
  tier: m.tier ?? 'Green',
  passport_on_file: Boolean(m.passport?.number),
  language: m.language,
  speech: { pace: m.speech?.pace },
  prefs: m.prefs,
  needs: m.needs,
  has_delegate: m.delegates?.some((d) => d.consent) ?? false,
});

const isSeeded = (seg) => Boolean(seg) && store.flights.some((f) => f.flight === seg.flight && f.dep === seg.dep && f.from === seg.from && f.to === seg.to);

// Booking details a member can choose. Anything else is dropped, so free text from a call never lands in these fields.
const SEATS = ['window', 'aisle'];
const SEAT_AREAS = ['front', 'middle', 'back'];
const MEALS = ['standard', 'vegetarian', 'vegan', 'halal', 'kosher', 'hindu', 'diabetic', 'low salt', 'gluten free', 'child'];
const SEAT_NUMBER = /^([1-9]|[1-6]\d|70)[ABCDEFGHJK]$/;   // rows 1-70, no I (as on Cathay's seat maps)
const MAX_REQUESTS = 3;
const pick = (value, allowed) => (allowed.includes(value) ? value : undefined);
const seatNumber = (value) => (SEAT_NUMBER.test(String(value ?? '').toUpperCase()) ? String(value).toUpperCase() : undefined);
const bags = (value) => (Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0);
const requests = (list) => (Array.isArray(list) ? list : []).map((r) => String(r).replace(/[\r\n]+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, MAX_REQUESTS);
const amount = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
/** Passport on the booking: country and the last 3 digits only. The number itself stays in Membership. */
const passportNote = (m) => (m.passport?.number ? `${m.passport.country} passport ending ${m.passport.number.slice(-3)}` : null);

async function route(req, res, url) {
  const path = url.pathname.slice('/mock-cathay'.length);
  const query = url.searchParams;
  const op = `${req.method} ${path}`;

  // ---- Membership: lookup returns the member id only, nothing else about the member.
  if (op === 'GET /membership/lookup') {
    const phone = digits(query.get('phone'));
    const member = phone && store.members.find((m) => digits(m.phone) === phone);
    return member ? send(res, 200, { member_id: member.member_id }) : send(res, 404, { error: 'no member with this number' });
  }

  // ---- Membership: a one-time code for the caller. Cathay would email it itself; this mock hands it to the adapter,
  // which emails it to the address on file for the calling number. The code is then checked here (below).
  if (op === 'POST /membership/otp') {
    const { member_id } = await readJson(req);
    if (!store.members.some((m) => m.member_id === member_id)) return send(res, 404, { error: 'no such member' });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    otps.set(member_id, { code, expires: Date.now() + OTP_TTL_MS });
    return send(res, 200, { ok: true, code });
  }

  // ---- Membership: the answer is checked here, so the caller of this route never sees the right one.
  // With a one-time code open for the member, only that code passes (once, before it expires).
  // Without one, the old question "where did you last fly with us?" still works.
  if (op === 'POST /membership/verify') {
    const { member_id, answer, call_id = null } = await readJson(req);
    const open = otps.get(member_id);
    if (open) {
      if (Date.now() > open.expires || digits(answer) !== open.code) return send(res, 200, { ok: false });
      otps.delete(member_id);
    } else {
      const lastFlown = ordersOf(member_id).find((o) => o.status === 'flown');
      if (!lastFlown || !answerMatches(lastFlown, answer)) return send(res, 200, { ok: false });
    }
    const token = newToken();
    // ponytail: tokens live until reset; give them an expiry when calls stop being one at a time.
    store.sessions.set(token, { member_id, call_id });
    return send(res, 200, { ok: true, token });
  }

  // ---- Schedule: round-trip search. `after` = leave after this date, `before` = be back before this date.
  if (op === 'GET /schedule/search') {
    const [from, to, after, before] = ['from', 'to', 'after', 'before'].map((k) => query.get(k) ?? '');
    const inWindow = (f) => day(f.dep) > after && (!before || day(f.arr) < before);
    const fareOf = (f) => store.fares.find((x) => x.flight === f.flight && x.date === day(f.dep))?.return_fare_hkd ?? null;
    return send(res, 200, {
      out: store.flights.filter((f) => f.from === from && f.to === to && inWindow(f)).map((f) => ({ ...f, return_fare_hkd: fareOf(f) })),
      back: store.flights.filter((f) => f.from === to && f.to === from && inWindow(f)),
    });
  }

  // ---- Fees for extras (illustrative, like the fares).
  if (op === 'GET /fees') return send(res, 200, { extra_bag_hkd: store.fees.extra_bag_hkd ?? null });

  // ---- Everything below needs the session token from a passed verification.
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const session = store.sessions.get(token);
  const member = session && findMember(session.member_id);
  if (!member) return send(res, 401, { error: 'verification needed' });

  const memberRoute = /^\/membership\/members\/([^/]+)(\/delegate)?$/.exec(path);
  if (req.method === 'GET' && memberRoute) {
    if (!['me', member.member_id].includes(memberRoute[1])) return send(res, 401, { error: 'verification needed' });
    if (!memberRoute[2]) return send(res, 200, modelSafeProfile(member));
    // The family payer and where to reach them. Stays on the server: tools never hand this to the model.
    const delegate = member.delegates?.find((d) => d.consent);
    return delegate
      ? send(res, 200, { name: delegate.name, relation: delegate.relation, phone: delegate.phone, email: delegate.email })
      : send(res, 404, { error: 'no delegate with consent on file' });
  }

  // ---- Orders: history (NDC OrderRetrieve style), newest first.
  if (op === 'GET /orders') return send(res, 200, ordersOf(member.member_id));

  // ---- Orders: unpaid hold (NDC OrderCreate style). The member comes from the token, not from the body.
  if (op === 'POST /orders') {
    const o = await readJson(req);
    if (!isSeeded(o.out) || !isSeeded(o.back)) return send(res, 422, { error: 'flight not in the schedule' });
    const fare = amount(o.fare_hkd);
    const extras = bags(o.extra_bags) * (store.fees.extra_bag_hkd ?? 0);
    const order = {
      ref: newRef(), member_id: member.member_id, status: 'held',
      option_id: o.option_id, out: o.out, back: o.back, fare_hkd: fare,
      cabin: o.cabin ?? 'economy', seat: pick(o.seat, SEATS), seat_area: pick(o.seat_area, SEAT_AREAS),
      ...(seatNumber(o.seat_number) && { seat_number: seatNumber(o.seat_number) }), meal: pick(o.meal, MEALS),
      extra_bags: bags(o.extra_bags), extras_hkd: extras, total_hkd: fare + extras, due_hkd: fare + extras,
      requests: requests(o.requests),
      ssr: (o.ssr ?? []).filter((code) => WHEELCHAIR_CODES.includes(code)),
      passport: passportNote(member),
      payer: o.payer, passenger: o.passenger,
    };
    store.orders.push(order);
    return send(res, 201, order);
  }

  // ---- Orders: change a booking that is held or paid (NDC OrderChange style): new flights, seat, meal or bags.
  // The new total is worked out here. A paid booking that now costs more goes back to held, with the difference due.
  const changeRoute = /^\/orders\/([A-Z0-9]{6})\/change$/.exec(path);
  if (req.method === 'POST' && changeRoute) {
    const order = store.orders.find((x) => x.ref === changeRoute[1] && x.member_id === member.member_id);
    if (!order || !['held', 'paid'].includes(order.status) || !order.out) return send(res, 404, { error: 'no booking to change' });
    const c = await readJson(req);
    if (c.out || c.back) {
      if (!isSeeded(c.out) || !isSeeded(c.back)) return send(res, 422, { error: 'flight not in the schedule' });
      if (amount(c.fare_hkd) == null) return send(res, 422, { error: 'no fare' });
    }
    const before = order.total_hkd ?? order.fare_hkd;
    if (c.out) Object.assign(order, { out: c.out, back: c.back, fare_hkd: amount(c.fare_hkd), option_id: c.option_id });
    if (pick(c.seat, SEATS)) order.seat = c.seat;
    if (pick(c.seat_area, SEAT_AREAS)) order.seat_area = c.seat_area;
    if (c.seat_number !== undefined) order.seat_number = seatNumber(c.seat_number);
    if (pick(c.meal, MEALS)) order.meal = c.meal;
    if (c.extra_bags !== undefined) Object.assign(order, { extra_bags: bags(c.extra_bags), extras_hkd: bags(c.extra_bags) * (store.fees.extra_bag_hkd ?? 0) });
    order.total_hkd = order.fare_hkd + (order.extras_hkd ?? 0);
    const difference = order.total_hkd - before;
    if (order.status === 'held') order.due_hkd = order.total_hkd;
    else if (difference > 0) {
      order.due_hkd = difference;
      store.paidEvents.delete(order.ref);   // so the payment of the difference is taken like a first payment
      setOrderStatus(order.ref, 'held');
    }
    order.changed = (order.changed ?? 0) + 1;
    return send(res, 200, { ...order, difference_hkd: difference });
  }

  return send(res, 404, { error: 'not found' });
}

/**
 * Serves /mock-cathay/*. Returns true if it took the request.
 * A request without our own service key is not taken (returns false), so the server answers it
 * with the same "Not found" as any other address.
 */
export function handleMockCathay(req, res) {
  const url = new URL(req.url, 'http://mock');
  if (!url.pathname.startsWith('/mock-cathay/')) return false;
  if (req.headers['x-service-key'] !== serviceKey) return false;
  route(req, res, url).catch(() => {
    if (!res.headersSent) send(res, 400, { error: 'bad request' });
    else res.end();
  });
  return true;
}
