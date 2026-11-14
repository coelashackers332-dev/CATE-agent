// In-memory state for the whole demo. Seeds come from data/*.json; reset() reloads them.
// ponytail: one process, one in-memory store. Production = Cathay's membership + booking systems.
import { readFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { config } from './config.js';
import { emit, newLog } from './events.js';

const seed = (name) => JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));

export const store = {
  /** @type {object[]} mock Membership system */ members: [],
  /** @type {object[]} mock Orders system: seeded flown orders + holds made by calls */ orders: [],
  /** @type {object[]} mock Schedule system */ flights: [],
  /** @type {object[]} */ fares: [],
  /** illustrative fees, e.g. { extra_bag_hkd } */ fees: {},
  /** view-only trip pages: code → { member_id, options, ref, expires } */ pages: new Map(),
  /** verification sessions: token → { member_id, call_id } */ sessions: new Map(),
  /** payment event ids already processed (Stripe can resend) */ paidEvents: new Set(),
  /** the one live call, or null (one call at a time) */ activeCall: null,
  refsIssued: 0,

  reset({ log = true } = {}) {
    this.members = seed('membership');
    this.orders = seed('orders');
    this.flights = seed('flights');
    this.fares = seed('fares');
    this.fees = seed('fees');
    this.pages.clear();
    this.sessions.clear();
    this.paidEvents.clear();
    this.activeCall = null;
    this.refsIssued = 0;
    applyEnvOverrides(this.members);
    newLog(log);
    emit(null, 'system', { system: 'Demo', action: 'reset', ok: true, summary: 'seed data reloaded' });
  },
};

// Real phone numbers and email addresses live only in .env, never in git.
function applyEnvOverrides(members) {
  const wong = members.find((m) => m.member_id === 'DEMO-0001');
  if (!wong) return;
  if (config.demoCallerNumber) wong.phone = config.demoCallerNumber;
  if (config.demoCallerEmail) wong.email = config.demoCallerEmail;
  const daniel = wong.delegates?.[0];
  if (daniel && config.danielPhone) daniel.phone = config.danielPhone;
  if (daniel && config.danielEmail) daniel.email = config.danielEmail;
}

const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Booking reference. In demo mode the first one is K7Q2XM so slides and screens match. */
export function newRef() {
  store.refsIssued += 1;
  if (config.demoMode && store.refsIssued === 1) return 'K7Q2XM';
  let ref;
  do ref = Array.from({ length: 6 }, () => REF_CHARS[randomInt(REF_CHARS.length)]).join('');
  while (store.orders.some((o) => o.ref === ref));
  return ref;
}

/** 128-bit random code for a view-only page link. */
export const newPageCode = () => randomBytes(16).toString('base64url');
/** Verification session token. */
export const newToken = () => randomBytes(16).toString('base64url');

export const findOrder = (ref) => store.orders.find((o) => o.ref === ref) ?? null;
export const findMember = (id) => store.members.find((m) => m.member_id === id) ?? null;

/** The only way an order changes status (held → paid). Emits a `state` event. */
export function setOrderStatus(ref, status) {
  const order = findOrder(ref);
  if (!order) throw new Error(`no order ${ref}`);
  order.status = status;
  emit(null, 'state', { ref, status });
  return order;
}

// Seeded at import without a log file; server.js calls store.reset() at startup to start logging.
store.reset({ log: false });
