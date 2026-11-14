# CATE tools

The voice model can only listen, talk, and choose one of the 8 tools on this page. Each tool is a function in our code (`src/tools.js`). The rules live in that function, so the model cannot talk its way past them.

| # | Tool | In one line |
|---|---|---|
| 1 | [`verify_caller`](#1-verify_caller) | Checks the caller is the member, from the phone number and one travel-history question |
| 2 | [`apply_profile`](#2-apply_profile) | Loads the member's name, preferences, needs and recent trips |
| 3 | [`find_flights`](#3-find_flights) | Returns up to 3 flight options from the schedule, matched to the profile |
| 4 | [`text_options`](#4-text_options) | Texts the options and a view-only trip page link to the caller |
| 5 | [`set_assistance`](#5-set_assistance) | Sets the wheelchair code from a fixed table |
| 6 | [`hold_booking`](#6-hold_booking) | Reads the trip back, then holds the booking after a yes |
| 7 | [`send_pay_link`](#7-send_pay_link) | Opens the payment page on the member's own phone (the member always pays himself) |
| 8 | [`ask_cathay`](#8-ask_cathay) | Answers a general question about flying with Cathay, from checked passages only |

The usual order in a call is 1 → 2 → 3 → 4 (optional) → 5 → 6 (twice) → 7. Tool 8 can be called at any point after verification, whenever the caller asks a general question.

## Rules that apply to every tool

- **Verification first.** Every tool except `verify_caller` is refused until verification has passed.
- **Only declared inputs get through.** Any extra field the model sends (a phone number, a name) is dropped before the tool runs.
- **A tool never throws to the model.** A problem comes back as `{ ok: false, error: "…" }`, where `error` is a plain-words instruction for the model, for example "Ask him which city again."
- **Every call is logged.** Each tool emits a `tool_call` and a `tool_result` event, shown on the projector view and written to the run log.
- **Cathay data goes through one adapter.** Tools reach member and booking data only through `src/cathay.js`. In the demo it talks to the mock Cathay systems.
- **Results carry speaking hints.** Fields such as `say`, `next`, `read_out` and `readback` tell the model what to say, so wording comes from our code and data.

---

## 1. `verify_caller`

Checks that the caller is the member. Call it as soon as the caller has answered "Where did you last fly with us?".

**Input**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `answer` | string | yes | What the caller said, e.g. "Osaka, last May" |

**Returns**

```json
{ "ok": true, "verified": true, "next": "Call apply_profile now." }
```

**Rules in code**

- The phone number comes from the phone network (the caller ID), never from speech or from the model.
- The answer is checked inside the mock Cathay system against the latest flown trip. It passes if it names that trip's city; if it also names a month, the month must match. The model never sees the correct answer.
- On a pass, the call gets a session token. Profile and booking requests are refused without it.
- **Three wrong answers lock the call** until the demo is reset.

**Refusals**

| When | The model is told |
|---|---|
| The answer does not match | Ask the question once more. Do not give hints. |
| The phone number is not on a membership | Say you cannot go on; a member of staff can help. |
| Three wrong answers already | Say you cannot go on; a member of staff can help. |

## 2. `apply_profile`

Loads what Cathay already knows about the member, so the caller does not have to repeat it. Call it right after verification passes.

**Input:** none.

**Returns**

```json
{ "ok": true,
  "profile": {
    "name": "WONG TAK MING", "language": "en", "speech": { "pace": "slow" },
    "prefs": { "seat": "window", "meal": "vegetarian", "bags": 1, "earliest_departure": "09:00" },
    "needs": { "walk_in_cabin": true, "stairs": true, "long_distance": false },
    "has_delegate": true,
    "recent_trips": [ { "to": "Osaka", "month": "2026-05", "status": "flown", "ssr": ["WCHR"],
                        "assistance": "Wheelchair from check-in to the gate. Can manage stairs and walk to the seat." } ]
  } }
```

**Rules in code**

- The model gets only what it needs to talk: name, preferences, needs, recent trips. It never gets phone numbers, email addresses or the family member's contact details (`has_delegate` is only yes or no).
- Each recent trip carries its assistance in plain words, so the model can say "like your Osaka trip?" without saying a code.
- The profile is read once per call and reused by the other tools.

## 3. `find_flights`

Finds flight options. Call it when the destination and both dates are known.

**Input**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `to` | string | yes | Destination city as the caller said it, e.g. "Vancouver" (airport codes also work) |
| `after` | string | yes | Leave after this date, `YYYY-MM-DD` |
| `before` | string | yes | Be back before this date, `YYYY-MM-DD` |
| `from` | string | no | Departure city. Left out means Hong Kong. |

The model must turn phrases such as "after Chinese New Year" into dates; the tool takes exact dates only.

**Returns**

```json
{ "ok": true,
  "options": [
    { "id": "1",
      "out":  { "flight": "CX0V1", "from": "HKG", "to": "YVR", "city": "Vancouver", "dep": "2027-02-19T11:40", "arr": "2027-02-19T07:40", "stops": [] },
      "back": { "flight": "CX0V2", "from": "YVR", "to": "HKG", "city": "Hong Kong", "dep": "2027-03-31T13:30", "arr": "2027-04-01T18:30", "stops": [] },
      "fare_hkd": 8420, "note": "" }
  ],
  "read_out": [ "The first option leaves on Friday 19 February at 11:40 am. It is direct, and costs 8,420 Hong Kong dollars return." ],
  "return_flight": "Every option comes back on Wednesday 31 March, leaving at 1:30 pm.",
  "left_out": "I left out 1 flight that leaves before 9:00 am, because you prefer not to leave that early.",
  "next": "After the return flight, say left_out. Then ask \"Shall I text these to you?\" and after that which option he would like. When he has chosen, call hold_booking with its option_id: it tells you what to ask him before the read-back." }
```

**Rules in code**

- Only flights in the schedule data that have a fare. An unknown city or dates with no flights return no option at all, never a guess.
- At most 3 options: one per flight number, direct flights first, then by departure time.
- Flights leaving before the member's `earliest_departure` are left out, and `left_out` says how many.
- One return flight is chosen for all options: not too early, direct if possible.
- `read_out` and `return_flight` are ready-made sentences. The model reads them, so it cannot say a time or price that is not in the data.
- Seat preference is not used for ranking (the demo data has no seat map). It is carried to the booking.

**Refusals**

| When | The model is told |
|---|---|
| Unknown city | No flights for that city. Do not suggest any flight. Ask which city again. |
| Dates missing or not `YYYY-MM-DD` | Two dates are needed. Ask him for the dates. |
| Nothing fits | No flights fit those dates. Ask if other dates would work. |

## 4. `text_options`

Texts the options to the caller, with a link to a large-text, view-only trip page. Call it only after the caller says yes to "Shall I text these to you?".

**Input:** none. The model cannot choose the phone number or the content.

**Returns**

```json
{ "ok": true, "sent": true,
  "say": "Tell him the text is on its way to the phone he is calling from, and that the link only shows his trip." }
```

**Rules in code**

- The text goes only to the number the call came from, which is the number on the membership. It never goes to a number said during the call.
- Only the options from this call's `find_flights` are sent.
- This tool creates the caller's trip page: a random 128-bit link that shows only his trip and expires the day after the trip. Before a call, no pages exist.

**Refusal:** no options yet → "Find flights first."

## 5. `set_assistance`

Sets the wheelchair assistance for the booking. Call it before holding the booking.

**Input** (either `same_as_last_trip`, or the three answers in order)

| Field | Type | Meaning |
|---|---|---|
| `same_as_last_trip` | boolean | True if he wants the same help as on his last flight |
| `walk_in_cabin` | boolean | "Can you walk to your seat inside the plane on your own?" |
| `stairs` | boolean | "Can you go up and down stairs?" |
| `long_distance` | boolean | "Can you walk long distances, like from check-in to the gate?" |

**Returns**

```json
{ "ok": true, "code": "WCHR",
  "summary": "Wheelchair from check-in to the gate. Can manage stairs and walk to the seat.",
  "say": "Never say the code.",
  "next": "If he has already chosen an option, do not speak yet: call hold_booking with its option_id now, then say the readback it returns. If he has not chosen one, read the summary back in plain words and ask which option he wants." }
```

**Rules in code**

The code comes from this fixed table of IATA special service request codes, never from the model's judgement. The questions are asked in order; the first "no" sets the code.

| First "no" to | Code | Plain words |
|---|---|---|
| Walk to the seat in the cabin | `WCHC` | Wheelchair all the way to the seat on the plane. |
| Stairs | `WCHS` | Wheelchair from check-in to the aircraft door, with help on stairs. Can walk to the seat on the plane. |
| Long distances | `WCHR` | Wheelchair from check-in to the gate. Can manage stairs and walk to the seat. |
| None (all "yes") | none | No wheelchair needed. |

- `same_as_last_trip` copies the code from the latest flown trip on file.
- Changing the assistance cancels any earlier read-back, so the caller always confirms the current version.

**Refusals**

| When | The model is told |
|---|---|
| A question has no answer yet | Ask him that question first. |
| `same_as_last_trip`, but nothing is on file | Ask the three questions instead. |

## 6. `hold_booking`

Holds the booking, in two steps, so nothing is held before the caller has heard the whole trip and said yes.

**Input**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `option_id` | string | yes | The id of the chosen option from `find_flights` |
| `caller_confirmed` | boolean | no | True only after he said yes to the read-back |

**Step 1: the read-back.** Called with `option_id` only:

```json
{ "ok": true, "needs_confirmation": true,
  "readback": "Let me read it all back to you. Nothing is booked until you say yes. Booking for Wong Tak Ming. Hong Kong to Vancouver, flight CX0V1, Friday 19 February, leaving at 11:40 am. Coming back on flight CX0V2, Wednesday 31 March, leaving at 1:30 pm. Window seat, vegetarian meal. Wheelchair from check-in to the gate. Can manage stairs and walk to the seat. The total is 8,420 Hong Kong dollars for the return trip. The pay request will come to your own phone. Shall I hold this booking?" }
```

**Step 2: the hold.** Called again with the same `option_id` and `caller_confirmed: true`:

```json
{ "ok": true, "ref": "K7Q2XM", "ref_spoken": "K 7 Q 2 X M", "status": "held",
  "say": "Tell him the booking is held and read the reference letter by letter. Then call send_pay_link." }
```

**Rules in code**

- A hold is made only if step 1 ran for the same option. `caller_confirmed: true` on a first call, or for a different option, returns the read-back again.
- Only an option from this call can be held.
- Assistance must be set first (`set_assistance`).
- The passenger name, seat and meal come from the profile, never from speech. A misheard name would not match the passport.
- The wheelchair code is stored on the booking as a special service request.
- The trip page now belongs to this booking. It is created here if no text was sent.
- Calling again after the hold returns the same reference (`already_held: true`); it does not create a second booking.
- In demo mode the first reference is always `K7Q2XM`, so slides and screens match.

**Refusals**

| When | The model is told |
|---|---|
| The option is not from this call | Ask which option he wants. |
| Assistance is not set | Ask about wheelchair help first, then hold the booking. |

## 7. `send_pay_link`

Opens the payment for the held booking on the member's own phone. The member always pays for his own booking. Call it right after the hold.

**Input:** none. The model cannot name a recipient.

**Returns**

```json
{ "ok": true, "sent_to": "his trip page",
  "say": "Tell him the payment page is now open on his phone, on the page from our email, and he can choose how to pay there. An email with his booking comes as soon as it is paid. Stay on the line." }
```

**Rules in code**

- Only to the member himself: with `PAYMENT=page` (the demo) his open trip page goes to the pay page `/pay/<code>` by itself while the booking is held, so nothing is sent. With `PAYMENT=sms` the pay request goes as a text to his own number on file ("Reply PAY").
- Nobody else can be asked to pay, and the model cannot name a recipient.
- Calling again does not send a second request (`already_sent: true`).
- The tool returns at once. Payment arrives later: when it does, the booking moves from `held` to `paid`, the member gets the booked email (booking reference and needs card), and the live call is told that the payment arrived.

**Refusals**

| When | The model is told |
|---|---|
| No held booking | Hold the booking first. |

## 8. `ask_cathay`

Answers a general question about flying with Cathay that is not about this booking: baggage, check-in times, wheelchair help at the airport, mobility aids, medical equipment, changing a ticket. This is retrieval-augmented generation (RAG): our code retrieves checked passages, and the model words a short answer from them.

**Input**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `question` | string | yes | The caller's question in his own words, e.g. "Can I bring my own wheelchair?" |

**Returns, when a passage is relevant**

```json
{ "ok": true, "found": true,
  "passages": [
    { "title": "Bringing your own wheelchair",
      "text": "You can bring your own wheelchair. Cathay carries it free of charge, on top of your baggage allowance. …",
      "source": "https://www.cathaypacific.com/cx/en_US/prepare-trip/help-for-passengers/disability-and-mobility-assistance/mobility-assistance.html",
      "checked": "2026-11-14 draft" }
  ],
  "say": "Answer only from these passages, in one or two short sentences, and say it is from the Cathay website. If they do not answer his question, say you do not have that information." }
```

**Returns, when nothing is relevant**

```json
{ "ok": true, "found": false,
  "say": "Say you do not have that information, and that a member of staff can help. Do not guess." }
```

**Rules in code**

- The model gets at most 3 passages, and only passages from `knowledge/*.md`. With no relevant passage it gets nothing to build an answer from, and is told to say so and offer a member of staff.
- Every passage has a source link and the date it was checked. A passage without both is skipped when the files are loaded, so nothing unsourced can be read out.
- The projector shows the source of each answer ("Cathay knowledge · Source: title · page · checked date"), or that there was no checked answer.
- "Relevant" is decided by the search, not the model. With `KNOWLEDGE=keyword` (current), a passage must contain at least half of the question's words, weighted by how rare they are. `KNOWLEDGE=embeddings` (planned, Amazon Bedrock) will match by meaning.
- Not for flights, prices or the caller's own booking: those come from `find_flights` and the booking.

**Refusal:** an empty question → "Ask him what he would like to know."

**Knowledge files.** Passages live in `knowledge/*.md`, one file per topic. Format: a `## Title` line, then `Source:`, `Checked:`, an optional `Asks:` line (ways a caller might put the question; searched, never read out), a blank line, and the answer in plain spoken words. The search is `src/knowledge.js`.

**Status of the passages.** The 23 passages are drafts, marked `Checked: 2026-11-14 draft`. They were written from search-result summaries of Cathay's pages and have not yet been verified against those pages by a person.

---

## For developers

```js
import { createTools } from './src/tools.js';

const { specs, runTool } = createTools({ cathay, messages, texts, emails, knowledge, baseUrl });
// specs:   [{ name, description, inputSchema }]  → given to the voice model as its tool list
// runTool: (name, args, call) → Promise<result>  → called when the model asks for a tool
```

- `cathay` is a factory `(callId) => adapter` (see `src/cathay.js`), so events carry the call id.
- `knowledge` is `{ search(question, limit) }` from `createKnowledge` in `src/knowledge.js`. It is optional: without it, `ask_cathay` always answers that it does not have the information.
- `call` is the call context from `CONTRACTS.md` §2. Tools keep their state on it: `verified`, `token`, `profile`, `options`, `assistance`, `pendingHold`, `ref`, `order`, `pageCode`, `payRequested`.
- Tests: `test/tools.test.js` covers each tool and its refusals; `test/knowledge.test.js` covers the search and the knowledge files; `test/golden.test.js` plays the whole booking call end to end.

**Status.** So far the 7 booking tools have been called only by the scripted stand-in (`src/model/scripted.js`), which calls them in the right order every time; `ask_cathay` has been called only from tests. None of the tools has yet been driven by the live voice model. The flights in the examples are placeholders until the real schedule snapshot is loaded, and the knowledge passages are unverified drafts.
