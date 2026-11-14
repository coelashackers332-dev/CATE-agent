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
  cabin: "economy", seat: "window", meal: "vegetarian", ssr: ["WCHR"], payer: "Daniel Wong",
  passenger: "WONG TAK MING" }
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
| `GET /v/:code` | Mr Wong, Daniel | random code; read-only; headers `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` |
| `POST /v/:code` | Mr Wong, during his call (answer buttons on his trip page) | only while the call that owns this page is live, verified and nothing is held (otherwise the same 404 as an unknown code); one field `option=<id of his options>` or `payer=self|family`, body ≤ 2 KB; runs `choose_option` / `set_payer` on that call, tells the model what was pressed (`session.notify`), then 303 back to GET |
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
- Eighth tool `ask_cathay({ question })` for general Cathay questions (RAG, `onday/RAG-PLAN.md` in the planning folder). It reads `deps.knowledge.search(question, limit) → Promise<[{ title, text, source, checked }]>`, which returns `[]` when nothing is relevant enough. The search is `src/knowledge.js`: `loadPassages()` reads `knowledge/*.md` (format in the file header; a passage without `Source` and `Checked` is skipped) and `createKnowledge({ passages, mode })` gives `{ search }`. `KNOWLEDGE=keyword` matches words and needs half the question's weighted words in a passage; `KNOWLEDGE=embeddings` is not built. `knowledge/` holds 23 draft passages (`Checked: 2026-11-14 draft`, not yet verified against Cathay's pages). `ask_cathay` also emits a `screen` event with `what: "knowledge"` naming the source. Details: `docs/TOOLS.md` §8.
- `server.js` exports `wireApp()` (real modules) besides `createApp(deps)` (injected, for tests).

## Changes on 2026-11-14: no Twilio, a Bluetooth phone line

- The phone number is a standby phone paired with the team laptop over Bluetooth. An audio bridge on the laptop moves the call audio; Twilio, μ-law and signature checks are gone (`src/twilio.js` → `src/phone.js`, `src/mulaw.js` removed, `twilio` package removed).
- `WS /local/stream?key=<ADMIN_SECRET>` (this machine only). The bridge sends text `{"event":"start"}` when the phone answers, then **binary** frames of PCM16 little-endian, 8 kHz mono (20 ms = 320 bytes is ideal; any even length works). The server sends binary frames in the same format to play, `{"event":"clear"}` on a barge-in (drop the audio not yet played), and `{"event":"busy"}` (then closes) if a call is already live. Hang-up: the bridge closes the socket; the server ends a call (for example on `/reset`) by closing it.
- Bluetooth gives the laptop no caller ID: a call on the local line is from DEMO-0001's number, as with `/dev/simulate`.
- No SMS in or out. Texts go by email (`TEXTS=email`, the default); `TEXTS=sms` only prints and is refused in live mode. There is no "Reply PAY": `POST /dev/pay` (admin) pays the latest held booking through `onPaid(ref, 'demo')`, 409 if nothing is held. The wrong-signature 403 is gone with Twilio.

## File ownership (tonight)

| Owner | Files |
|---|---|
| shared (done) | `src/config.js`, `src/events.js`, `src/store.js`, `data/*`, this file, `CLAUDE.md`, `package.json` |
| Agent A: tools | `src/tools.js`, `src/cathay.js`, `src/mock-cathay/*`, `test/tools.test.js`, `test/cathay.test.js` |
| Agent B: server | `src/server.js`, `src/phone.js` (was `twilio.js`), `src/messages.js`, `src/payment.js`, `test/server.test.js` |
| Agent C: screens | `src/screens/*`, `test/screens.test.js` |
| Integration (after) | `src/model/scripted.js`, wiring fixes |
