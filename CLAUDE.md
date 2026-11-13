# CATE code repo

CATE lets an older traveller book a Cathay flight by phone call. Hackathon prototype for Cathay Hackathon 2026, team E332. Planning docs live outside this repo in `D:\CATHAY HACKATHON\` (`onday/STACK.md`, `onday/STACK-AWS.md`, `onday/DATA.md`); this repo is what the judges get, so keep internal notes out of it.

Contracts between modules: `CONTRACTS.md`. Read it before writing code.

## Rules

- **Every line is new.** AWS and Twilio samples are reading material only; never paste sample code. Cathay gets an IP licence over this repo.
- **Dependencies:** MIT / BSD / Apache-2.0 only. No GPL/AGPL. Don't add a dependency for what a few lines do; the Node standard library comes first.
- **No secrets or real phone numbers in git.** They go in `.env` (see `.env.example`).
- **The AI talks, our code decides** (`STACK.md` §1): names, flights, fares and wheelchair codes come from tools and data, never from the model.
- **Demo path:** one rehearsed golden path on seeded data. Reset with `POST /reset`.

## Team setup (internal)

Setting up Claude Code for a teammate → follow `team/CLAUDE-SETUP.md`. `team/` also holds the 24-h timeline PDF. It's internal and is deleted before `git tag submission`.

## Commands

- `npm start`: run the server (`node src/server.js`)
- `npm test`: run all tests (`node --test`)
- Node 22+, ES modules, no build step, no framework.
