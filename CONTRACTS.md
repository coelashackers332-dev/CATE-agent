# CATE code contracts

Every module is written against this file. If you need to change a contract, stop and say so in your report; don't change it on your own.

Design docs (read-only, in the planning folder `D:\CATHAY HACKATHON\`): `onday/STACK.md` (§1 core rule, §2 messages and view-only pages, §3 golden path, §4 tools, §8 pitfalls), `onday/STACK-AWS.md` (§3 call flow), `onday/DATA.md` (§2a mock Cathay systems, §4 shapes, §5 seed data, §7 reset). Where they disagree, `STACK.md` wins (it is newer): for example, trip pages are rendered on every open from the booking's current state, not saved once.

## Already written (shared; don't edit)

- `src/config.js`: `config` from `.env`. See `.env.example`.
- `src/events.js`: `emit(callId, kind, fields)`, `bus.on('event', fn)`, `KINDS`.
- `src/store.js`: `store` (members, orders, flights, fares, pages, sessions, paidEvents, activeCall, `reset()`), `newRef()`, `newPageCode()`, `newToken()`, `findOrder(ref)`, `findMember(id)`, `setOrderStatus(ref, status)`.
- `data/*.json`: seed data (placeholder flights until the OAG snapshot).

## 1. Event (`src/events.js`)

```js
{ t: "12:01:07", call_id: "c1" | null, kind, ...fields }
```

| kind | fields | emitted by |
|---|---|---|
| `caller_said` | `text` | model driver |
| `cate_said` | `text` | model driver |
| `tool_call` | `name`, `args` | `runTool` |
| `tool_result` | `name`, `result` (what the model sees) | `runTool` |
| `system` | `system` ("Membership" \| "Orders" \| "Schedule" \| "Messages" \| "Payment" \| "Phone" \| "Demo"), `action`, `ok`, `summary` | `cathay.js`, messages, payment, reset |
| `screen` | `what` ("options_page" \| "pay_email" \| "sms" \| "knowledge"), `summary` | tools |
| `state` | `ref`, `status` | `setOrderStatus` |

`summary` is one short line for the projector, e.g. `"✓ member found (DEMO-0001)"`. Events never carry phone numbers or email addresses.

## 2. Call context

One object per call, created by the server when a call starts and stored in `store.activeCall`:

```js
{
  id: "c1",                 // unique per call
  callerId: "+852…",        // from the phone network; never shown or sent to the model
  memberId: null,           // set by verify_caller after lookup
  token: null,              // set by verify_caller on a pass
  verified: false,
  options: [],              // last find_flights result (with option ids)
  pageCode: null,           // set by text_options
  pendingHold: null,        // set by hold_booking's read-back step
  assistance: null,         // set by set_assistance
  ref: null,                // set by hold_booking
  session: null,            // the model session (section 5)
}
```

## 3. Tools (`src/tools.js`)

```js
export function createTools(deps) → { specs, runTool }
// deps = { cathay, messages, texts, emails, baseUrl }   (injected so tests can stub them)
// specs: [{ name, description, inputSchema }]           (JSON Schema; descriptions are written for the voice model)
// runTool(name, args, call) → Promise<object>           (emits tool_call + tool_result; never throws to the model:
//                                                         errors come back as { ok: false, error: "plain words" })
```

The 7 tools and their rules are in `STACK.md` §4. Rules live in code, not in the prompt:

- Nothing about the member is returned before `verify_caller` passes. The model never sees the correct answer.
- `find_flights` returns only seeded flights, 2–3 options, ranked by profile (seat, `earliest_departure`); each option has an `id`.
- `set_assistance` maps the 3 answers to WCHC / WCHS / WCHR / none with the fixed table; returns the code **and** a plain-words summary. "Like last time?" uses the SSR on the latest flown order.
- `hold_booking` is two-step: first call `{ option_id }` returns `{ readback: "…", needs_confirmation: true }` and stores `call.pendingHold`; second call `{ option_id, caller_confirmed: true }` with the same option creates the hold. Name comes from the profile. Demo mode: first ref is `K7Q2XM` (`newRef()`).
- `text_options` sends only to the verified member's number on file, only this call's options; creates the page (`store.pages.set(code, { member_id, options, ref: null, expires })`) and puts the link in text 1.
- `send_pay_link` goes only to the delegate's email/phone on file. With `config.payment === 'sms'` it sends Daniel the pay email + an SMS "Reply PAY". It returns `{ ok: true, sent_to: "Daniel" }` at once; payment arrives later through `onPaid` (section 6).

### Shapes shared by tools, screens and payment

```js
// segment
{ flight: "CX0V1", from: "HKG", to: "YVR", city: "Vancouver", dep: "2027-02-19T11:40", arr: "2027-02-19T07:40", stops: [] }
// option (find_flights result item; also stored on the trip page)
{ id: "1", out: segment, back: segment, fare_hkd: 8420, note: "" | "via Tokyo, 4.5 hours longer" }
// order (a hold made by hold_booking; same array as the seeded flown orders)
{ ref: "K7Q2XM", member_id: "DEMO-0001", status: "held" | "paid" | "ended",
  option_id: "1", out: segment, back: segment, fare_hkd: 8420,
  cabin: "economy", seat: "window", seat_area: "front", seat_number?: "21A", meal: "vegetarian",
  extra_bags: 1, extras_hkd: 500, total_hkd: 8920, due_hkd: 8920,   // due = what the pay page charges (only the difference after a change)
  requests: ["His wife's birthday on 26 December"], passport: "HKG passport ending 478",
  ssr: ["WCHR"], payer: "Wong Tak Ming", passenger: "WONG TAK MING" }
```

Golden-path expectation from the seed data (`DATA.md` §5): Vancouver, out after 2027-02-06, back before 2027-04-05, earliest departure 09:00 → 3 options: 11:40 HKD 8,420 · 23:50 HKD 7,960 · 09:10 via Tokyo HKD 6,900; return 31 Mar 13:30. The 06:30 flight is filtered as too early.

`set_assistance` stores its result on the call as `call.assistance = { code: "WCHR" | "WCHS" | "WCHC" | null, summary }`; `hold_booking` copies the code into `order.ssr`.

## 4. Mock Cathay (`src/mock-cathay/routes.js`, `src/cathay.js`)

```js
// routes.js
export function handleMockCathay(req, res) → boolean   // true if it handled a /mock-cathay/* request
// cathay.js  (the only file tools use to reach Cathay data; talks HTTP to /mock-cathay on config.baseUrl or a given base)
export function createCathay({ base, callId }) → {
  findMemberByPhone(phone) → { member_id } | null,
  checkVerification(memberId, answer) → { ok, token? },
  getProfile(token) → modelSafeProfile,          // 401 → throws
  getTripHistory(token) → trips[],
  searchFlights({ from, to, after, before }) → flights with fares,
  holdOrder(token, order) → { ref },
  getFees() → { extra_bag_hkd },                 // illustrative (data/fees.json)
  getBookings(token) → his held or paid orders, not flown,
  changeOrder(token, ref, change) → order + difference_hkd,   // POST /mock-cathay/orders/<ref>/change
}
```

Each call emits one `system` event (DATA.md §2a "What the projector shows"). `modelSafeProfile` is the shape in DATA.md §4: no phone, email or delegate contacts, plus `tier` and `passport_on_file` (true/false; never the number).

## 5. Model session (`src/model/<name>.js`)

```js
export function startSession({ call, specs, runTool, sendAudio, onInterrupt, emit }) → {
  audioIn(pcm16),   // Int16Array, 8 kHz mono, 20 ms frames from the phone
  notify(text),     // out-of-band info for the model, e.g. "Daniel has paid for K7Q2XM"
  close(),
}
// sendAudio(pcm16)  : model → caller audio (8 kHz Int16Array); the server sends it to the bridge as is
// onInterrupt()     : caller talked over CATE; the server sends the bridge {"event":"clear"}
```

`MODEL=scripted` (built tonight) ignores audio and plays the golden path by calling `runTool` in order and emitting `caller_said` / `cate_said`. `MODEL=nova` (Saturday) implements the same interface with Nova 2 Sonic.

## 6. Messages, texts, emails, payment

```js
// src/messages.js
export function createMessages({ mode }) → { sendSms(to, body), sendEmail(to, subject, html, text) }   // mode 'log' prints; 'live' sends
// src/screens/texts.js   (plain ASCII only, STACK.md §2 SMS rules)
export function optionsSms(options, link) → string
export function bookedSms(order, profile, link) → string
export function payRequestSms(order, travellerName) → string        // "Reply PAY"
// src/screens/emails.js  (inline styles, ≥20 px, one column)
export function payEmail({ order, travellerName, payerName, payUrl }) → { subject, html, text }
// src/screens/trip.js
export function renderTripPage({ page, order, profile, now }) → string   // full HTML; states: options | confirmed (+ needs card) | ended
export function notFoundPage() → string
// src/screens/pay.js  (the pay page; Harell's screen, in Cavell's design)
export const METHODS → [{ id, label, note? }]        // card, Apple Pay, Google Pay, FPS, PayMe, AlipayHK, Octopus
export const BACK_AFTER_S = 3
export function renderPayPage({ order, code, nonce, error }) → string   // held: only the ways to pay and one Pay button (with the amount)
export function renderPaidPage({ order, code, nonce }) → string         // paid: "Payment successful", back to /v/:code after BACK_AFTER_S s (and a button)
// src/payment.js  (server side)
export function onPaid(ref, source) → void   // idempotent: setOrderStatus(ref,'paid'), order.paid_with = source, notify the live session, then text 2
payRoute(req, res, code, notFound)           // GET/POST /pay/:code (section 7)
```

## 7. HTTP routes (`src/server.js`)

| Route | Who | Protection |
|---|---|---|
| `WS /local/stream` | the audio bridge on the team laptop (the `/bridge` page) | local only (no `X-Forwarded-For`) + admin secret (`?key=`); one call at a time |
| `GET /v/:code` | Mr Wong | random code; read-only; with `PAYMENT=page`, a 303 to `/pay/:code` while the booking is held (the member pays himself); headers `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` |
| `POST /v/:code` | Mr Wong, during his call (answer buttons on his trip page) | only while the call that owns this page is live, verified and nothing is held (otherwise the same 404 as an unknown code); one field `option=<id of his options>`, body ≤ 2 KB; runs `choose_option` on that call, tells the model what was pressed (`session.notify`), then 303 back to GET |
| `GET /pay/:code`, `POST /pay/:code` | the payer: Mr Wong (Pay button on his trip page) or Daniel (pay email) | the trip page's random code; only while the booking is held (after payment, GET shows "Payment successful" and goes back to `/v/:code`); POST takes one field `method` from `METHODS`, body ≤ 2 KB, then 303 back to GET; no card or personal fields; headers as `/v/` plus a nonce CSP and `X-Frame-Options: DENY` |
| `GET /projector` + `WS /events` | team laptop | admin secret (`?key=`) |
| `GET /bridge` | team laptop: the audio bridge page (`screens/bridge.html`). The call is answered on the laptop (Phone Link, audio through virtual cables) and the page connects it to `WS /local/stream` | this machine only + admin secret (`?key=`) |
| `POST /reset`, `POST /dev/simulate`, `POST /dev/pay` | team laptop | admin secret (`x-admin-key` header) |
| `/mock-cathay/*` | our own `cathay.js` | local only |
| everything else, including `/` | nobody | the same "Not found" |

## Changes made during the build (2026-11-13)

- `createTools` takes `deps.cathay` as a factory `(callId) => adapter`, so system events carry the call id.
- `cathay.searchFlights` is one round-trip search and returns `{ out, back }`. `holdOrder` returns the full order. `getDelegate(token)` was added (server side only; contacts never reach the model). `getProfile` has no `recent_trips`; `apply_profile` merges them from `getTripHistory`.
- `/mock-cathay/*` answers only local requests carrying the per-process service key (`src/mock-cathay/key.js`).
- Tools keep extra fields on the call: `profile`, `order`, `verifyFails`, `payRequested`. Three wrong verification answers lock the call until reset. `hold_booking` refuses until `set_assistance` has run, and it sets `page.ref`. `find_flights` needs both dates as `YYYY-MM-DD`.
- The server emits `system` events from "Phone" (`call started`, `call ended`); the projector's call status uses them.
- Wrong admin key, unknown or expired page codes and unknown paths all return the same not-found page (404). A bad Twilio signature returns 403.
- `PAYMENT=sms`: `payEmail` gets `payUrl: null` and tells the payer to reply PAY.
- 2026-11-14: no Twilio for the demo (calls reach a team phone bridged to a laptop), so PAY by text can't arrive. Payment is the demo pay page at `/pay/<trip page code>` (no money moves). `PAYMENT=page`: `send_pay_link` passes `payUrl: \`${baseUrl}/pay/${call.pageCode}\`` to `payEmail` and sends no "Reply PAY" text; when the traveller pays himself, the trip page shows a Pay button to the same link while the booking is held. A call started without Twilio must use the demo caller's number as `callerId` (as `/dev/simulate` does), because text 1 goes to that number's address on file.
- 2026-11-15 (game plan): the member always pays for his own booking. `set_payer` is gone, nobody is asked who pays, and nothing goes to the family payer. With `PAYMENT=page`, `hold_booking` is followed straight by `send_pay_link`, which sends nothing: the trip page redirects to `/pay/<code>` while the booking is held. After payment the member gets the booked email (`bookedEmail`).
- 2026-11-15 (game plan, personal booking manager): `verify_caller` refuses members below Gold unless they have a registered assistance need. New tools `set_baggage`, `set_special_request`, `find_booking`, `change_booking`; `set_preferences` takes a seat (window/aisle), cabin area, seat number or meal. Orders carry `seat_area`, `seat_number`, `extra_bags`, `extras_hkd`, `total_hkd`, `due_hkd`, `requests` and `passport` (last 3 digits). The pay page charges `due_hkd`. With `PAYMENT=page` the options and trip link are emailed on the first `find_flights`, and the confirmed hold opens the pay page itself. Seed: a second member (Green, Taipei) for the tier gate.
- 2026-11-15 (code by email, exact dates, demo readiness): verification is a one-time code by email. New tool `send_code` (mock `POST /membership/otp`; the line runs it when a call starts, `src/phone.js`); `verify_caller` takes `code` instead of `answer`, only after the caller has spoken since the code went out; the mock checks the code once, within 10 minutes. `find_flights` takes exact days `depart_on` / `return_on` (or the old `after` / `before` window), and every option has its own return flight at least one night later. New tool `keep_as_last_time`. `hold_booking` step 1 sets `page.summary` (the "Check your booking" card) and a yes counts only after CATE has said "Shall I hold this booking?". The bridge starts a call on the DOM event `cate-answered` (sent by the auto-answer script); `?trigger=audio` keeps the old start on sound. The pay page may be framed by our own site (`frame-ancestors 'self'`) so the projector can show it. Texts sent by email get the time in their subject. A barge-in is logged as a `system` event (`Phone`, `barge-in`). `PROMPT=demo` with `src/model/prompt_demo.js` is an optional short stage call.
