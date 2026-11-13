// MOCK Cathay systems (DATA.md §2a): Membership, Orders and Schedule over the in-memory store.
// Same process as CATE, but behind a real HTTP boundary. Only src/cathay.js calls these routes.
// In production that adapter points at Cathay's own systems and this folder is not used.
import { store, newRef, newToken, findMember } from '../store.js';
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

/** What CATE may hand the voice model (DATA.md §4): no phone, no email, no delegate contacts. */
const modelSafeProfile = (m) => ({
  name: `${m.name.family} ${m.name.given}`,
  language: m.language,
  speech: { pace: m.speech?.pace },
  prefs: m.prefs,
  needs: m.needs,
  has_delegate: m.delegates?.some((d) => d.consent) ?? false,
});

const isSeeded = (seg) => Boolean(seg) && store.flights.some((f) => f.flight === seg.flight && f.dep === seg.dep && f.from === seg.from && f.to === seg.to);

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

  // ---- Membership: the answer is checked here, so the caller of this route never sees the right one.
  if (op === 'POST /membership/verify') {
    const { member_id, answer, call_id = null } = await readJson(req);
    const lastFlown = ordersOf(member_id).find((o) => o.status === 'flown');
    if (!lastFlown || !answerMatches(lastFlown, answer)) return send(res, 200, { ok: false });
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
    const order = {
      ref: newRef(), member_id: member.member_id, status: 'held',
      option_id: o.option_id, out: o.out, back: o.back, fare_hkd: o.fare_hkd,
      cabin: o.cabin ?? 'economy', seat: o.seat, meal: o.meal,
      ssr: (o.ssr ?? []).filter((code) => WHEELCHAIR_CODES.includes(code)),
      payer: o.payer, passenger: o.passenger,
    };
    store.orders.push(order);
    return send(res, 201, order);
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
