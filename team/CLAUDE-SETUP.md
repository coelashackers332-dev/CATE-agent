# Claude Code setup for team E332

> **Internal. Delete `team/` before `git tag submission` (Sun 10:15).**

**For the teammate:** open Claude Code in this repo and type:

```
Read team/CLAUDE-SETUP.md and set me up. I'm <your name>.
```

Claude does the rest. When it's finished, restart Claude Code.

---

## Instructions for Claude

You are setting up Claude Code for one member of team E332 (Cathay Hackathon, 14–15 Nov 2026). Follow the steps in order. Run the commands yourself with your shell tool, show the output, and stop to report if a step fails. Don't install anything that isn't listed here.

### 1. Who is this?

The user must say their name: **Owen, Marvel, Harell, Cavell or Max**. If they didn't, ask. Never guess from the machine, git config or anything else.

### 2. Check the machine

Run these and report the versions:

```
claude --version
node --version
git --version
```

- `claude` must be 2.1.292 or later (needed for `claude plugin install --marketplace`). If it's older, run `claude update` first.
- Node must be 22 or later (the repo needs it). If it's missing or older, tell the user to install Node 22 LTS from https://nodejs.org and stop there.
- **Windows:** if the shell is PowerShell, `npm test` / `npm start` may be blocked by the execution policy. In this repo, use `node --test`, `node src/server.js` and `curl.exe` (not `curl`) instead. Tell the user this once.

### 3. Add the marketplaces

Run each command. "Already added" counts as success.

```
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin marketplace add JuliusBrussee/caveman
claude plugin marketplace add DietrichGebert/ponytail
```

Add these too, but only for the person named:

| Person | Extra marketplace |
|---|---|
| Marvel | `claude plugin marketplace add addyosmani/agent-skills` |
| Max | `claude plugin marketplace add anthropics/skills` |

### 4. Plugins for everyone

These install at user scope, so they work in every project:

```
claude plugin install superpowers@claude-plugins-official
claude plugin install caveman@caveman
claude plugin install ponytail@ponytail
```

- **superpowers**: work in steps (brainstorm → plan → test-driven build → verify), plus systematic debugging.
- **caveman**: short replies, saves tokens. `/caveman lite|full|ultra`; say "normal mode" to turn it off.
- **ponytail**: write the least code that works, so nobody over-builds at 3 am. Say "stop ponytail" to turn it off.

### 5. Plugins for this person's role

Install only the row for the person named in step 1.

| Person | Stream | Install |
|---|---|---|
| **Owen** | Voice: Nova 2 Sonic driver (`src/model/nova.js`) | `aws-core@claude-plugins-official` · `twilio-developer-kit@claude-plugins-official` · `context7@claude-plugins-official` |
| **Marvel** | Prompt, RAG passages, rules + tests | `agent-skills@addy-agent-skills` · `context7@claude-plugins-official` |
| **Harell** | Infra (EC2, Caddy, IAM, SSM), live SMS + email, payment, security pass | `aws-core@claude-plugins-official` · `twilio-developer-kit@claude-plugins-official` · `stripe@claude-plugins-official` · `security-guidance@claude-plugins-official` |
| **Cavell** | Projector + trip page on real phones, screenshots, fallback video | `frontend-design@claude-plugins-official` · `playwright@claude-plugins-official` |
| **Max** | Deck, one-pager, submissions | `document-skills@anthropic-agent-skills` · `canva@claude-plugins-official` |

Run one `claude plugin install <plugin>` per entry. Why each one:

- **aws-core**: AWS skills for Bedrock, EC2, IAM and SSM. The stack is Twilio → EC2 Tokyo → Nova 2 Sonic.
- **twilio-developer-kit**: Twilio's own skills for Voice Media Streams, SMS and webhook signatures.
- **context7**: up-to-date library docs, e.g. the AWS SDK's Bedrock bidirectional stream, without guessing from old training data.
- **agent-skills** (Addy Osmani): test-driven development, context engineering, source-driven development. The RAG passages must cite their Cathay source links.
- **stripe**: Stripe test-mode Checkout and webhooks. Use the `sk_test_` key from `.env`. If the plugin asks to log in to a Stripe account, skip that.
- **security-guidance**: warns about injection, leaked secrets and similar on every edit, and reviews the diff. Use it for the security pass.
- **frontend-design**: polish for the trip page and the projector view.
- **playwright**: drives a browser to take phone-size screenshots of the trip page and projector.
- **document-skills**: pptx / pdf / docx skills for the slides PDF and the one-pager.
- **canva**: edit the team's Canva designs. Log in only if Max uses Canva for the one-pager.

If an install asks for a login or an API key, skip that part and tell the user. Nothing in the demo path needs it.

### 6. Personal note in `~/.claude/CLAUDE.md`

Write a note so that in every future session the agent knows who it works for, without asking. The file is the user's personal Claude memory (`~/.claude/CLAUDE.md`; on Windows `%USERPROFILE%\.claude\CLAUDE.md`). It's outside git, and Claude Code reads it at the start of every session.

- If the file doesn't exist, create it.
- If it exists, **keep everything in it** and add the note at the end. If it already has a `## CATE-agent repo` section, replace only that section.
- Show the user the final note.

The note is the block for the person named in step 1:

**Owen**
```
## CATE-agent repo (Cathay Hackathon, team E332, 14–15 Nov 2026)
When working in the CATE-agent repo, I'm Owen: voice, the Nova 2 Sonic driver.
My files: src/model/nova.js, src/mulaw.js. I merge all fixes after the Sun 03:00 freeze.
Stage: I speak parts 4–6 and answer tech questions. Everything else: follow team/GIT.md and the repo CLAUDE.md.
```

**Marvel**
```
## CATE-agent repo (Cathay Hackathon, team E332, 14–15 Nov 2026)
When working in the CATE-agent repo, I'm Marvel: system prompt, RAG passages, booking rules + tests.
My files: src/tools.js, src/knowledge.js, src/model/prompt.js, knowledge/, data/.
Stage: I'm the caller (Mr Wong). Everything else: follow team/GIT.md and the repo CLAUDE.md.
```

**Harell**
```
## CATE-agent repo (Cathay Hackathon, team E332, 14–15 Nov 2026)
When working in the CATE-agent repo, I'm Harell: infra (EC2, Caddy, IAM, SSM), live SMS + email, payment, security pass.
My files: src/messages.js, src/payment.js, deploy.sh + Caddy config, README.md, .env.example. I'm the only one who deploys and adds dependencies.
Stage: Daniel's phone + timekeeper. Everything else: follow team/GIT.md and the repo CLAUDE.md.
```

**Cavell**
```
## CATE-agent repo (Cathay Hackathon, team E332, 14–15 Nov 2026)
When working in the CATE-agent repo, I'm Cavell: projector view, trip page on real phones, screenshots, fallback video.
My files: src/screens/*.
Stage: operator, I drive the laptop. Everything else: follow team/GIT.md and the repo CLAUDE.md.
```

**Max**
```
## CATE-agent repo (Cathay Hackathon, team E332, 14–15 Nov 2026)
When working in the CATE-agent repo, I'm Max: pitch, deck, one-pager, submissions. I own no code files, only team/.
Stage: I speak parts 1–3 and 7 and lead Q&A. Everything else: follow team/GIT.md and the repo CLAUDE.md.
```

### 7. Check

```
claude plugin list
```

Every plugin from steps 4 and 5 must show as enabled. Then tell the user:

1. Quit Claude Code and start it again in this folder (or run `/reload-plugins`).
2. Type `/` and check that `caveman`, `ponytail` and the `superpowers:` skills appear.
3. Run `node --test` in this repo. All tests should pass.

### 8. Hand over

Finish with:

- The person's role and stage job from the table above.
- Where their hour-by-hour tasks are: `team/PLAN-24H-timeline.pdf` (their column) and the live plan at https://claude.ai/artifact/LfnC79vPPo9BkwSyLzgsYm (ask Max for access).
- How we share the repo: `team/GIT.md`. Summarise for them which files they own (§1) and the per-task flow (§2).
- The repo rules from `CLAUDE.md`: every line is new (samples are reading material only), MIT / BSD / Apache-2.0 dependencies only, no secrets or real phone numbers in git (they go in `.env`), and read `CONTRACTS.md` before writing code.

### Don't

- Don't install plugins beyond this list. Each one adds context to every message.
- Don't put API keys, tokens or phone numbers in any file in git.
- Don't edit `~/.claude/settings.json` by hand. The `claude plugin` commands handle it.
