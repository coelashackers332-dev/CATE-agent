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
| `system` | `system` ("Membership" \| "Orders" \| "Schedule" \| "Messages" \| "Payment" \| "Demo"), `action`, `ok`, `summary` | `cathay.js`, messages, payment, reset |
| `screen` | `what` ("options_page" \| "pay_email" \| "sms"), `summary` | tools |
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
}
```

Each call emits one `system` event (DATA.md §2a "What the projector shows"). `modelSafeProfile` is the shape in DATA.md §4: no phone, email or delegate contacts.

## 5. Model session (`src/model/<name>.js`)

```js
export function startSession({ call, specs, runTool, sendAudio, onInterrupt, emit }) → {
  audioIn(pcm16),   // Int16Array, 8 kHz mono, 20 ms frames from the phone
  notify(text),     // out-of-band info for the model, e.g. "Daniel has paid for K7Q2XM"
  close(),
}
// sendAudio(pcm16)  : model → caller audio (8 kHz Int16Array); the server converts to μ-law for Twilio
// onInterrupt()     : caller talked over CATE; the server sends Twilio `clear`
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
// src/payment.js  (server side)
export function onPaid(ref, source) → void   // idempotent: setOrderStatus(ref,'paid'), text 2, notify the live session
```

## 7. HTTP routes (`src/server.js`)

| Route | Who | Protection |
|---|---|---|
| `POST /twilio/voice` | Twilio | `X-Twilio-Signature`; one call at a time; unknown number → short message + hang up |
| `WS /twilio/stream` | Twilio | one-time token passed as `<Parameter>`, checked in `start` |
| `POST /twilio/sms` | Twilio | signature; `PAY` only from the delegate's number, only while held |
| `GET /v/:code` | Mr Wong, Daniel | random code; read-only; headers `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` |
| `GET /projector` + `WS /events` | team laptop | admin secret (`?key=`) |
| `POST /reset`, `POST /dev/simulate` | team laptop | admin secret (`x-admin-key` header) |
| `/mock-cathay/*` | our own `cathay.js` | local only |
| everything else, including `/` | nobody | the same "Not found" |

## File ownership (tonight)

| Owner | Files |
|---|---|
| shared (done) | `src/config.js`, `src/events.js`, `src/store.js`, `data/*`, this file, `CLAUDE.md`, `package.json` |
| Agent A: tools | `src/tools.js`, `src/cathay.js`, `src/mock-cathay/*`, `test/tools.test.js`, `test/cathay.test.js` |
| Agent B: server | `src/server.js`, `src/twilio.js`, `src/mulaw.js`, `src/messages.js`, `src/payment.js`, `test/server.test.js`, `test/mulaw.test.js` |
| Agent C: screens | `src/screens/*`, `test/screens.test.js` |
| Integration (after) | `src/model/scripted.js`, wiring fixes |
