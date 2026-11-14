# CATE: Cathay Automated Travel Expert

Book a Cathay flight by phone call, with no app, no forms and no codes.

CATE is a voice assistant for travellers who find online booking hard: older travellers, and people with visual, cognitive or communication needs. The traveller calls a phone number and says their trip and their needs once, in their own words. CATE finds the flights, sets the wheelchair assistance, reads everything back, and holds the booking. A family member pays through a link sent to them. The traveller gets the booking and a "needs card" by text, to show staff at check-in, immigration and the gate.

Built for **Cathay Hackathon 2026**, challenge *Premium Travel: Making Travel More Accessible*, by team **E332 Coelas Hackers**.

> **Status: working prototype.** A real phone call to the standby phone is answered automatically, Amazon Nova 2 Sonic talks with the caller, and the booking, texts (sent as email), pay page and booked confirmation run end to end on Cathay's real schedule (OAG). The [Status](#status) table below shows what exists.

## How a call works

The demo follows one caller, Mr Wong (74), who wants to visit family in Vancouver:

1. **Verify.** Mr Wong calls from his own phone. CATE matches the caller ID to his membership and asks one question from his travel history: "Where did you last fly with us?"
2. **Say the trip.** "Vancouver after Chinese New Year, back before Ching Ming. Window seat, not too early."
3. **Options.** CATE reads up to 3 options, from the schedule and ranked by his profile, and sends one link (by email) to his trip page, where he can also tap the option he wants.
4. **Assistance.** "Wheelchair to the gate, like Osaka?" CATE sets the IATA code (WCHR / WCHS / WCHC) from a fixed rule table and reads it back in plain words.
5. **Read-back and hold.** CATE reads the whole trip back and holds the booking only after he says yes.
6. **Pay.** Once the booking is held, his open trip page turns into the payment page. He picks a way to pay and sees "Payment successful".
7. **Booked.** The page goes back to his trip, now booked, and he gets an email with the booking reference and his needs card.
8. **Next time.** On his next call: "Same as your Vancouver trip?"

## Core rule: the AI talks, our code decides

The voice model only listens, talks and chooses which tool to call. Every action that matters runs as a tool in our code, with its rule enforced there:

- **Names** come from the verified member profile, never from speech, so the ticket matches the passport.
- **Flights and fares** come from our data. The model can't invent a flight or a price.
- **Wheelchair codes** come from a fixed rule table, not from the model's judgement.
- **Nothing about the member** reaches the model before verification passes, and the model never sees the correct verification answer.
- **General Cathay answers** come only from checked passages, each with its source. With no relevant passage, CATE says it does not have that information and offers a member of staff.

The 8 tools, with their inputs, results and rules, are documented in [`docs/TOOLS.md`](docs/TOOLS.md).

## Architecture

```
Caller's phone ──► standby phone (the number Mr Wong calls)
                     │ Bluetooth: the call's audio
                     ▼
                  audio bridge on the laptop
                     │ WebSocket /local/stream: 8 kHz PCM16 both ways
                     ▼
                  CATE server (Node.js, on the same laptop)
                    ├─ tools: verify_caller · apply_profile · find_flights · set_assistance
                    │         hold_booking · text_options · send_pay_link
                    ├─ cathay.js ──► mock Cathay systems (Membership · Orders · Schedule)
                    ├─ trip pages (view-only links) · projector view
                    │
                    └─ two-way audio stream ──► Amazon Bedrock: Nova 2 Sonic (speech to speech)
```

**Mocked for the demo.** We have no access to Cathay's systems, so the server includes mock Membership, Orders and Schedule systems behind one adapter (`src/cathay.js`). Their operations are modelled on public IATA NDC message names (`OrderCreate`, `AirShopping`). In production, that adapter points at Cathay's membership and booking systems and nothing else changes. Flight schedules are a real Cathay schedule snapshot (OAG, November–December 2026); the demo flights in February–March 2027 are placeholders. Fares are illustrative. Payment is a demo pay page; no money moves.

## Status

| Part | State |
|---|---|
| Module contracts (`CONTRACTS.md`), configuration, event log, in-memory store, seed data | ✅ Done |
| Mock Cathay systems + adapter, the booking tools and their rules | ✅ Done, tested |
| Server: local phone line for the Bluetooth bridge, view-only pages, reset | ✅ Done, tested with real phone calls |
| Screens: projector view, trip page with needs card (choose a flight by button during the call), texts sent as email, booked email | ✅ Done, tested |
| Payment: the member pays himself on the demo pay page `/pay/<code>` (`PAYMENT=page`), which his trip page opens by itself once the booking is held; `POST /dev/pay` as a stage fallback | ✅ Done, tested |
| Scripted stand-in for the voice model (plays the golden path, no audio) | ✅ Done |
| General Cathay questions (`ask_cathay`): search over passages in `knowledge/`, source shown on the projector | ✅ Tool and keyword search done, tested. The 23 passages are drafts, not yet verified against Cathay's pages. Search by meaning (embeddings) is planned. |
| Voice model: Amazon Nova 2 Sonic over the call audio (`MODEL=nova`) | ✅ Done, run on real calls through Bedrock (Tokyo) |
| Live email, texts sent as email (`TEXTS=email`) | ✅ Done, tested |
| Real schedules (OAG snapshot): every Cathay route from Hong Kong, November–December 2026 | ✅ Done |
| Real card checkout (Stripe or Cathay's payment gateway) | Planned for production |

## Repo layout

```
CONTRACTS.md          interfaces between modules (read before writing code)
CLAUDE.md             working rules for this repo
data/                 seed data for the mock Cathay systems (JSON)
docs/                 TOOLS.md (the 8 tools)
src/server.js         HTTP routes, projector feed, wiring
src/phone.js          the phone line: call audio from the Bluetooth bridge, life of a call
src/tools.js          the 8 tools and their rules
src/knowledge.js      search over the knowledge passages (for ask_cathay)
knowledge/            general Cathay knowledge: short passages, each with source and date checked
src/cathay.js         the one adapter to Cathay's systems
src/mock-cathay/      mock Membership, Orders and Schedule systems
src/model/            voice model drivers (scripted.js, nova.js)
src/screens/          projector view, trip page, texts, emails
src/payment.js        what happens when a booking is paid
src/messages.js       texts and email (log, or live by email)
src/config.js, events.js, store.js   settings, event bus + run log, in-memory state
test/                 node --test; golden.test.js plays the whole booking
```

## Run it

Requires Node.js 22 or later.

```sh
npm install
cp .env.example .env     # then fill in your own values
npm test                 # node --test
npm start                # node src/server.js; prints the projector address
```

To play the whole booking without a phone (`MODEL=scripted`), open the projector address in a browser, then:

```sh
curl -X POST -H "x-admin-key: <ADMIN_SECRET>" http://localhost:8080/dev/simulate          # the call
curl -X POST -H "x-admin-key: <ADMIN_SECRET>" http://localhost:8080/dev/pay               # the member pays (or pay on the page his trip link opens)
curl -X POST -H "x-admin-key: <ADMIN_SECRET>" http://localhost:8080/reset                 # start again
```

The trip page link is printed in the server console with the text message.

All settings are in `.env.example`. `MODEL=scripted` runs the golden path without a voice model, and `MESSAGES=log` prints texts and emails to the console instead of sending them.

## Privacy and security

- **No real personal data in git.** The demo caller's and family member's real phone numbers live only in `.env` (never committed); the seed data uses placeholders.
- **Minimum data to the model.** After verification the model gets name, preferences, needs and recent trips, never phone numbers, email addresses or the family member's contact details.
- **View-only links.** Trip pages open only from a 128-bit random link created during a call. They are read-only, never indexed, never cached, and show only name, flights and needs.
- **Local phone line.** Call audio is accepted only from this machine (not through a tunnel or proxy) and only with the admin secret. The projector view, reset and the `/dev` routes need the admin secret too.
- **One call at a time,** so a second caller can't change the demo's state.

## Licences

Direct dependencies: [`ws`](https://github.com/websockets/ws) (MIT) and the AWS SDK for JavaScript (`@aws-sdk/client-bedrock-runtime`, `@smithy/node-http-handler`; Apache-2.0). All 29 installed packages, including indirect ones, use permissive licences (Apache-2.0, MIT, 0BSD); none is copyleft. All code in this repo was written for this hackathon.
