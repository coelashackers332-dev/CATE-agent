// The one adapter between CATE and Cathay's systems (DATA.md §2a). Tools reach Cathay data only through this file.
// Demo: HTTP to the mock Membership / Orders / Schedule routes in this same process.
// Production: point these functions at Cathay's membership and booking systems; nothing else changes.
// Every function emits exactly one `system` event: one line on the projector. No phone numbers or emails in events.
import { config } from './config.js';
import { emit } from './events.js';
import { serviceKey } from './mock-cathay/key.js';

const monthYear = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const ssrText = (ssr) => (ssr?.length ? ssr.join(', ') : 'no assistance');

/**
 * @param {object} o
 * @param {string} [o.base]    where the Cathay systems are. Default: this server on loopback, not the public URL,
 *                             so member data never takes a round trip over the internet.
 * @param {string|null} [o.callId]  call id put on the projector lines
 */
export function createCathay({ base = `http://127.0.0.1:${config.port}`, callId = null } = {}) {
  async function http(method, path, { token, body } = {}) {
    const res = await fetch(`${base}/mock-cathay${path}`, {
      method,
      headers: {
        'x-service-key': serviceKey,
        ...(token && { authorization: `Bearer ${token}` }),
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  const need = ({ status, data }) => {
    if (status >= 400) throw new Error(status === 401 ? 'not verified (401)' : `refused (${status})`);
    return data;
  };

  /** Runs one request and emits its one projector line, pass or fail. `run` returns { result, summary, ok? }. */
  async function step(system, action, run) {
    try {
      const { result, summary, ok = true } = await run();
      emit(callId, 'system', { system, action, ok, summary });
      return result;
    } catch (err) {
      emit(callId, 'system', { system, action, ok: false, summary: `✗ ${err.message}` });
      throw err;
    }
  }

  return {
    /** → { member_id } | null. Returns the member id only: no name, no profile. */
    findMemberByPhone: (phone) => step('Membership', 'lookup by phone', async () => {
      const r = await http('GET', `/membership/lookup?phone=${encodeURIComponent(phone ?? '')}`);
      if (r.status === 404) return { result: null, ok: false, summary: '✗ number not recognised' };
      const { member_id } = need(r);
      return { result: { member_id }, summary: `✓ member found (${member_id})` };
    }),

    /** → { ok, token? }. The answer is compared inside Cathay's system; the right answer never comes back. */
    checkVerification: (memberId, answer) => step('Membership', `verify "${String(answer ?? '').slice(0, 40)}"`, async () => {
      const { ok, token } = need(await http('POST', '/membership/verify', { body: { member_id: memberId, answer, call_id: callId } }));
      return ok ? { result: { ok: true, token }, summary: '✓ passed' } : { result: { ok: false }, ok: false, summary: '✗ did not match' };
    }),

    /** → model-safe profile (DATA.md §4, without recent_trips). Throws without a valid token. */
    getProfile: (token) => step('Membership', 'profile', async () => {
      const profile = need(await http('GET', '/membership/members/me', { token }));
      const { seat, meal, bags, earliest_departure: earliest } = profile.prefs ?? {};
      const parts = [seat, meal, bags != null && `${bags} bag${bags === 1 ? '' : 's'}`, earliest && `not before ${earliest}`];
      return { result: profile, summary: parts.filter(Boolean).join(' · ') };
    }),

    /**
     * → { name, relation, phone, email } | null: the family payer on file, with consent.
     * Server side only (send_pay_link). Never put this in a tool result. Not in CONTRACTS §4; added because
     * the model-safe profile carries no contacts and tools may reach Cathay data only through this file.
     */
    getDelegate: (token) => step('Membership', 'family payer on file', async () => {
      const r = await http('GET', '/membership/members/me/delegate', { token });
      if (r.status === 404) return { result: null, ok: false, summary: '✗ none on file' };
      const delegate = need(r);
      return { result: delegate, summary: `✓ ${delegate.name.split(' ')[0]} (${delegate.relation}), consent on file` };
    }),

    /** → last 3 trips, newest first: [{ to: "Osaka", month: "2026-05", status, ssr }]. Throws without a valid token. */
    getTripHistory: (token) => step('Orders', 'history', async () => {
      const orders = need(await http('GET', '/orders?member=me', { token })).slice(0, 3);
      const first = (o) => o.segments?.[0] ?? o.out;   // seeded flown orders have segments; CATE holds have out/back
      const month = (o) => (first(o).date ?? first(o).dep).slice(0, 7);
      const trips = orders.map((o) => ({ to: first(o).city, month: month(o), status: o.status, ssr: o.ssr ?? [] }));
      const line = (o) => `${first(o).from}→${first(o).to} ${monthYear.format(new Date(`${month(o)}-01T00:00Z`))} · ${ssrText(o.ssr)}`;
      return { result: trips, summary: orders.map(line).join(' | ') || 'no trips on file' };
    }),

    /**
     * Round-trip shopping: leave `from` for `to` after date `after`, be back before date `before` (YYYY-MM-DD).
     * → { out: flights with `return_fare_hkd` (null if we have no fare), back: flights }
     */
    searchFlights: ({ from, to, after, before }) => step('Schedule', `search ${from}→${to}`, async () => {
      const found = need(await http('GET', `/schedule/search?${new URLSearchParams({ from, to, after, before: before ?? '' })}`));
      return { result: found, ok: found.out.length > 0, summary: `${found.out.length} flights out · ${found.back.length} back` };
    }),

    /** → the created order, including `ref`. An unpaid hold; the wheelchair code travels as an SSR. */
    holdOrder: (token, order) => step('Orders', 'hold (OrderCreate)', async () => {
      const created = need(await http('POST', '/orders', { token, body: order }));
      return { result: created, summary: `${created.ref} · ${ssrText(created.ssr)}` };
    }),
  };
}
