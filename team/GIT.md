# How we share the repo (team E332, 14–15 Nov)

> **Internal. Delete `team/` before `git tag submission` (Sun 10:15).**

Five people, five Claude Code agents, one repo. `main` must always run the golden path. Everyone works on short branches and merges back often. Each file has one owner, so agents don't overwrite each other's work.

## 1. Who owns which file

| Owner | Files |
|---|---|
| **Owen** | `src/model/nova.js` (new), `src/mulaw.js` |
| **Marvel** | `src/tools.js`, `src/knowledge.js`, `knowledge/`, `data/`, `src/model/prompt.js` (new: the system prompt + tool descriptions; `nova.js` imports it) |
| **Harell** | `src/messages.js`, `src/payment.js`, deploy scripts (`deploy.sh`, Caddy config), `README.md`, `.env.example` |
| **Cavell** | `src/screens/*` |
| **Max** | no code. Deck and one-pager live outside the repo; `team/` |
| **Shared** | `src/server.js`, `src/twilio.js` (Owen: audio stream · Harell: signature check), `src/config.js`, `src/events.js`, `src/store.js`, `src/cathay.js`, `src/mock-cathay/*`, `CONTRACTS.md`, `CLAUDE.md`, `package.json`, `package-lock.json` |

Tests follow their code: a test that covers your file is yours too.

**Shared files:** announce in the team chat first ("editing server.js: adding /twilio/sms route"), keep the change small, and merge it right away. A change to `CONTRACTS.md` needs an OK from every owner it affects. Only Harell adds dependencies: ask him, MIT / BSD / Apache-2.0 only.

## 2. Flow for each task

```
git switch main
git pull --rebase
git switch -c <name>/<task>          # e.g. owen/nova-stream, cavell/text2-short
# work, small commits
node --test                          # must pass
git fetch origin
git rebase origin/main               # conflicts: see §4
node --test                          # again, after the rebase
git switch main
git pull --rebase
git merge --ff-only <name>/<task>
git push origin main
git branch -d <name>/<task>
```

- **Branch name:** `<your name>/<short task>`, in lowercase.
- **Merge within 1–2 hours.** A branch older than that becomes a 2 am merge conflict, so cut the task smaller.
- **No pull request** when you only touched your own files. **Open one** when you touched a shared file (`git push -u origin <branch>`, then a PR on GitHub), so the other owner sees it. Merge it once they say OK or after 15 minutes of silence.
- **Commits:** small, one idea each, message in plain English ("Shorten text 2 to one SMS part"). A bad commit is then undone with `git revert`, not by hand.

## 3. Red `main`

If `node --test` fails on `main`, whoever merged last fixes it before doing anything else. Nobody merges on top of a red `main`. A fix that takes longer than 15 minutes means `git revert` of the bad commit, push, then fix it on a branch.

## 4. Conflicts

- In **your own files**: resolve them, run `node --test`, continue.
- In **someone else's file** or a **shared file**: stop, `git rebase --abort`, and ask the owner. Don't pick a side for them.

## 5. Gates, deploy, freeze

- **Before each gate** (Sat 15:00, Sat 20:30): everyone merges 30 minutes early. Harell deploys `main` and the gate test runs on the server.
- **Deploy:** only Harell, only `main`, through `deploy.sh`. Nobody edits code on the EC2 server; a fix made there is lost on the next deploy.
- **Code freeze Sun 03:00** (`git tag freeze`): after it, only `fix/<what>` branches, and **only Owen merges**. Ask him; don't merge yourself.
- **Sun 10:15:** Harell deletes `team/` and the "Team" section of `CLAUDE.md`, runs `node --test`, `git tag submission`, push. Nothing is pushed after 10:30.

## 6. Never

- `git push --force` (or `-f`, `--force-with-lease`) to `main`
- `git reset --hard` on `main`, or deleting someone else's branch
- committing `.env`, keys, tokens or real phone numbers
- `git add -A` / `git add .` without reading `git status` first
- editing another person's file to make your tests pass: tell the owner instead

## 7. GitHub setting (Max, once)

Settings → Branches → Add rule for `main` → tick **Block force pushes**. Deletion is blocked by the same rule. Nothing else; required reviews would slow a 24-hour build.
