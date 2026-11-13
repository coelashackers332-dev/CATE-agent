# CATE: Cathay Automated Travel Expert

Book a Cathay flight by phone call, with no app, no forms and no codes.

CATE is a voice assistant for travellers who find online booking hard: older travellers, and people with visual, cognitive or communication needs. The traveller calls a phone number and says their trip and their needs once, in their own words. CATE finds the flights, sets the wheelchair assistance, reads everything back, and holds the booking. A family member pays through a link sent to them. The traveller gets the booking and a "needs card" by text, to show staff at check-in, immigration and the gate.

Built for **Cathay Hackathon 2026**, challenge *Premium Travel: Making Travel More Accessible*, by team **E332 Coelas Hackers**.

> **Status: work in progress.** This repo currently holds the scaffold: module contracts, configuration, the event log, the in-memory store and the seed data. The tools, server, screens and voice model are built during the hackathon. The [Status](#status) table below shows what exists.

## How a call works

The demo follows one caller, Mr Wong (74), who wants to visit family in Vancouver:

1. **Verify.** Mr Wong calls from his own phone. CATE matches the caller ID to his membership and asks one question from his travel history: "Where did you last fly with us?"
2. **Say the trip.** "Vancouver after Chinese New Year, back before Ching Ming. Window seat, not too early."
3. **Options.** CATE reads 2–3 options slowly, from the schedule and ranked by his profile, and offers to text them with a large-text link.
4. **Assistance.** "Wheelchair to the gate, like Osaka?" CATE sets the IATA code (WCHR / WCHS / WCHC) from a fixed rule table and reads it back in plain words.
5. **Read-back and hold.** CATE reads the whole trip back and holds the booking only after he says yes.
6. **Family pays.** His son Daniel, linked to his profile, gets the pay request.
7. **Booked.** Mr Wong gets a text with the booking reference and his needs card.
8. **Next time.** On his next call: "Same as your Vancouver trip?"

## Core rule: the AI talks, our code decides

The voice model only listens, talks and chooses which tool to call. Every action that matters runs as a tool in our code, with its rule enforced there:

- **Names** come from the verified member profile, never from speech, so the ticket matches the passport.
- **Flights and fares** come from our data. The model can't invent a flight or a price.
- **Wheelchair codes** come from a fixed rule table, not from the model's judgement.
- **Nothing about the member** reaches the model before verification passes, and the model never sees the correct verification answer.

## Architecture

![CATE architecture: Twilio phone line → Amazon EC2 → Amazon Bedrock Nova Sonic](docs/architecture.png)

```
Caller's phone ──► Twilio (phone number, call audio 8 kHz μ-law, SMS)
                     │ WebSocket
                     ▼
                  CATE server (Node.js, Amazon EC2, Tokyo)
                    ├─ tools: verify_caller · apply_profile · find_flights · set_assistance
                    │         hold_booking · text_options · send_pay_link
                    ├─ cathay.js ──► mock Cathay systems (Membership · Orders · Schedule)
                    ├─ trip pages (view-only links) · projector view
                    │
                    └─ two-way audio stream ──► Amazon Bedrock: Nova 2 Sonic (speech to speech)
```

**Mocked for the demo.** We have no access to Cathay's systems, so the server includes mock Membership, Orders and Schedule systems behind one adapter (`src/cathay.js`). Their operations are modelled on public IATA NDC message names (`OrderCreate`, `AirShopping`). In production, that adapter points at Cathay's membership and booking systems and nothing else changes. Fares are illustrative. Flight schedules are placeholders until they are replaced by an OAG schedule snapshot. Payment is in test mode; no money moves.

## Status

| Part | State |
|---|---|
| Module contracts (`CONTRACTS.md`), configuration, event log, in-memory store, seed data | ✅ Done |
| Mock Cathay systems + adapter, the 7 tools and their rules | Planned |
| Server: Twilio webhook and call audio, signature checks, view-only pages, reset | Planned |
| Screens: projector view, trip page with needs card, texts, pay email | Planned |
| Voice model: Amazon Nova 2 Sonic over the call audio | Planned |
| Real schedules (OAG snapshot), live SMS, payment (Stripe test mode) | Planned |

## Repo layout

```
CONTRACTS.md      interfaces between modules (read before writing code)
CLAUDE.md         working rules for this repo
data/             seed data for the mock Cathay systems (JSON)
docs/             architecture diagram
src/config.js     settings from .env
src/events.js     call event bus + one log file per run
src/store.js      in-memory state: members, orders, pages, sessions; reset
```

## Run it

Requires Node.js 22 or later.

```sh
npm install
cp .env.example .env     # then fill in your own values
npm test                 # node --test
npm start                # node src/server.js (once the server is in)
```

All settings are in `.env.example`. `MODEL=scripted` runs the golden path without a voice model, and `MESSAGES=log` prints texts and emails to the console instead of sending them.

## Privacy and security

- **No real personal data in git.** The demo caller's and family member's real phone numbers live only in `.env` (never committed); the seed data uses placeholders.
- **Minimum data to the model.** After verification the model gets name, preferences, needs and recent trips, never phone numbers, email addresses or the family member's contact details.
- **View-only links.** Trip pages open only from a 128-bit random link created during a call. They are read-only, never indexed, never cached, and show only name, flights and needs.
- **Signed requests.** Every request from Twilio (and from Stripe) is checked for its signature. The projector view and reset need an admin secret.
- **One call at a time,** so a second caller can't change the demo's state.

## Licences

Direct dependencies: [`ws`](https://github.com/websockets/ws) (MIT) and [`twilio`](https://github.com/twilio/twilio-node) (MIT). All 53 installed packages, including indirect ones, use permissive licences (MIT, BSD-3-Clause, Apache-2.0, ISC); none is copyleft. All code in this repo was written for this hackathon.
