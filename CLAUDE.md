# CATE code repo

CATE lets an older traveller book a Cathay flight by phone call. Hackathon prototype for Cathay Hackathon 2026, team E332. Planning docs live outside this repo in `D:\CATHAY HACKATHON\` (`onday/STACK.md`, `onday/STACK-AWS.md`, `onday/DATA.md`); this repo is what the judges get, so keep internal notes out of it.

Contracts between modules: `CONTRACTS.md`. Read it before writing code.

## Rules

- **Every line is new.** AWS and Twilio samples are reading material only; never paste sample code. Cathay gets an IP licence over this repo.
- **Dependencies:** MIT / BSD / Apache-2.0 only. No GPL/AGPL. Don't add a dependency for what a few lines do; the Node standard library comes first.
- **No secrets or real phone numbers in git.** They go in `.env` (see `.env.example`).
- **The AI talks, our code decides** (`STACK.md` §1): names, flights, fares and wheelchair codes come from tools and data, never from the model.
- **Demo path:** one rehearsed golden path on seeded data. Reset with `POST /reset`.

## Team (internal: delete this section and `team/` before `git tag submission`)

Five teammates work in this repo at once, each with their own Claude. Setting up Claude Code for a teammate → follow `team/CLAUDE-SETUP.md`. Timeline: `team/PLAN-24H-timeline.pdf`. The full git workflow is in `team/GIT.md`. Read it before the first commit of a session. Always:

- **Know who you work for.** The user's personal `~/.claude/CLAUDE.md` names them (written during setup). If it doesn't, ask the user's name (Owen, Marvel, Harell, Cavell, Max) once per session. File owners are in `team/GIT.md` §1.
- **Start of session:** `git switch main && git pull --rebase`, then work on a branch `<name>/<task>`. Never commit straight onto `main`.
- **Edit only the user's own files.** Shared files (`server.js`, `twilio.js`, `config.js`, `events.js`, `store.js`, `cathay.js`, `mock-cathay/`, `CONTRACTS.md`, `package.json`): remind the user to announce the change in the team chat first, keep it small, and open a PR. Never edit another person's file to make tests pass; tell the user who owns it.
- **Before merging:** `node --test` passes, rebase on `origin/main`, test again, then `git merge --ff-only` into `main` and push. Merge within 1–2 hours.
- **Conflicts** in someone else's or a shared file: `git rebase --abort` and ask the owner. Don't resolve it for them.
- **Never:** force-push, `git reset --hard` on `main`, `git add -A` without reading `git status`, commit `.env` or secrets, deploy (Marvel or Owen only), merge after the Sun 03:00 freeze (Owen only).

## Commands

- `npm start`: run the server (`node src/server.js`)
- `npm test`: run all tests (`node --test`)
- Node 22+, ES modules, no build step, no framework.
