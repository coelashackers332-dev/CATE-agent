# How the code works

A guide for reading the CATE code. It follows one phone call through the files, then lists every file and where each rule lives. The tools themselves (inputs, results, refusals) are in [`TOOLS.md`](TOOLS.md); the interfaces between modules are in [`CONTRACTS.md`](../CONTRACTS.md).

**The one idea behind the design: the AI talks, our code decides.** The voice model (Amazon Nova 2 Sonic) only listens, speaks and picks a tool. Everything that matters (who the caller is, which flights exist, what they cost, which wheelchair code applies, when a booking is held) is decided by a tool in `src/tools.js` and the Cathay systems behind `src/cathay.js`. The model cannot talk its way past a rule, because the rule is code.

## One call, step by step

| # | What happens | Where |
|---|---|---|
| 1 | The call is answered and its audio reaches the laptop. The `/bridge` page captures it and opens the phone line. | `src/screens/bridge.html` → `WS /local/stream` |
| 2 | The line creates the call, emails the caller a one-time code at once, and starts the voice model. | `src/phone.js` (`local`, `begin`) |
| 3 | The voice model gets the system prompt and the tool list, and greets the caller. | `src/model/nova.js` (`startSession`), `src/model/prompt.js` (`systemPrompt`), `src/tools.js` (`specs`) |
| 4 | Each time the model wants something done, it calls a tool. The tool checks its rules and answers with facts and a hint of what to say next. | `src/model/nova.js` (`answerTool`) → `src/tools.js` (`runTool`, `handlers`) |
| 5 | Tools read and write Cathay data only through one adapter, which talks to the mock Cathay systems. | `src/cathay.js` → `src/mock-cathay/routes.js` → `src/store.js` (data from `data/*.json`) |
| 6 | Messages (the code, the trip link, the booking) go out as email. | `src/messages.js`, wording in `src/screens/texts.js` and `src/screens/emails.js` |
| 7 | The caller sees his options and his booking on a view-only trip page, and can tap a flight there. | `src/server.js` (`GET` and `POST /v/:code`) → `src/screens/trip.js` |
| 8 | After the hold, the trip page opens the payment page; paying marks the booking paid and tells the model. | `src/payment.js` → `src/screens/pay.js` |
| 9 | Every step is an event, shown live on the projector view and written to a log file. | `src/events.js` (`emit`) → `src/server.js` (`WS /events`) → `src/screens/projector.html`; `logs/*.jsonl` |

## Files

| File | What it does |
|---|---|
| `src/server.js` | The one HTTP server: every route, the projector feed, and `wireApp()`, which connects all modules. Start here to see how things fit. |
| `src/phone.js` | The phone line: one call at a time, call audio in and out, the start and end of a call. |
| `src/model/nova.js` | The live voice model: Amazon Nova 2 Sonic over Bedrock's two-way stream. Sends audio and tool results, receives speech and tool calls. |
| `src/model/prompt.js` | The system prompt: who CATE is, how it talks, the order of a call. A shorter stage version (`prompt_demo.js`, `PROMPT=demo`) was used for the live demo and is not included; without it, CATE runs the full call. |
| `src/model/scripted.js` | A stand-in for the voice model with no audio: it plays one rehearsed booking by calling the real tools. Used by the golden test and `POST /dev/simulate`. |
| `src/model/echo.js` | A stand-in that plays the caller's voice back, to test the audio line without the model. |
| `src/tools.js` | The 16 tools and all their rules. See the map at the top of the file. |
| `src/cathay.js` | The only adapter to Cathay's systems (Membership, Orders, Schedule). In production it points at Cathay's real systems; nothing else changes. |
| `src/mock-cathay/routes.js` | The mock Cathay systems used in the prototype. Checks the one-time code, holds and changes orders (NDC OrderCreate / OrderChange style), searches the schedule. |
| `src/store.js` | In-memory state: members, orders, flights, fares, trip pages, the live call. `reset()` reloads the seed data. |
| `src/payment.js` | The pay page routes and what happens when a booking is paid. |
| `src/messages.js` | Outgoing messages: printed (`MESSAGES=log`) or sent by email through a mail account (`MESSAGES=live`), with Node's own TLS. |
| `src/knowledge.js` | Search over the checked passages in `knowledge/*.md`, for general questions (`ask_cathay`). |
| `src/events.js` | The event bus and the run log. |
| `src/config.js` | Reads `.env`. All settings are listed in `.env.example`. |
| `src/screens/trip.js` | The trip page: options, the "Check your booking" card, the held booking, the confirmed booking with the needs card. |
| `src/screens/pay.js` | The pay page and the "Payment successful" page. |
| `src/screens/texts.js`, `emails.js` | Message wording: the options text, the pay request, the booked text and the booked email. |
| `src/screens/projector.html` | The live view for the room: the conversation, the caller's phone, and (key `T`) every tool call and system step. |
| `src/screens/bridge.html` | The audio bridge on the laptop: moves call audio between the call app and the phone line. |

## Where each rule lives

| Rule | Code |
|---|---|
| The caller is who they say: a one-time code to the email on file, checked inside the Membership system, once, within 10 minutes; 3 wrong codes end the call | `send_code`, `verify_caller` in `tools.js`; `POST /membership/otp` and `/membership/verify` in `mock-cathay/routes.js` |
| The model never sees the code, the email address, phone numbers or the passport number | tools return only model-safe fields; `runTool` drops any input a tool does not declare |
| A code the model makes up is refused | `verify_caller` checks that the caller has spoken since the code went out |
| Only Gold members and above, or members with a registered assistance need | `verify_caller` (tier gate) |
| Flights and prices come only from the schedule, never from the model | `find_flights`; `read_out` sentences are built from the data |
| No same-day return; exact days are respected | `find_flights` (`backFor`, the `exact` branch) |
| Wheelchair help comes from a fixed table, never from the model | `RULES` and `ASSISTANCE` in `tools.js`, used by `set_assistance` and `keep_as_last_time` |
| Nothing is held without a clear yes after the read-back | `hold_booking` (two steps, and the "heard the question" check) |
| Payment only on the pay page, never by voice; a payment notice never comes from the caller | `send_pay_link`, `payment.js`; the prompt's rules |
| Trip and pay pages are view-only, unguessable links; the phone line and admin pages work only on the laptop | `server.js` (`isLocal`, `isAdmin`), `newPageCode` in `store.js` |

## Inside `src/tools.js`

1. **Rules as data** (top of the file): cities we fly, the wheelchair table, tiers, seat and meal lists, limits.
2. **`specs`**: the tool list the voice model sees: name, description, inputs.
3. **`createTools(deps)`**: shared helpers (`profileOf`, `tripPage`, `readback`, `nextStep`, `recorded`), then `handlers`, one function per tool, then `runTool`, the single entry point that checks verification, filters inputs, runs the tool and logs it.

Each tool result can carry hints for the model: `say` (what to tell the caller), `next` (the one next question), `confirm` (an answer to say back), `readback` and `read_out` (exact sentences to read). The model follows hints in tool results more reliably than the prompt, so the order of a call is steered from here.

## Data

| File | Contents |
|---|---|
| `data/membership.json` | The demo members: name, tier, contact details, seat and meal preferences, needs, passport (last digits) |
| `data/orders.json` | Past trips (used for "same as last time" and the history) |
| `data/flights.json` | The schedule: real Cathay flights (OAG, 14 Nov – 31 Dec 2026) plus 7 rehearsed demo flights |
| `data/fares.json` | Illustrative economy return fares, one per flight per day |
| `data/fees.json` | Illustrative fees, e.g. an extra bag |
| `knowledge/*.md` | Short passages about flying with Cathay, each with its source and date |

## Tests

`npm test` runs every test (`node --test`). `test/golden.test.js` plays a whole booking end to end with the scripted model; `test/tools.test.js` covers each tool and its refusals; the other files cover the server, pages, messages, payment, the prompt and the voice model driver.
