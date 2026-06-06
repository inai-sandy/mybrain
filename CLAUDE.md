# Project rules — Claude MUST follow these

You build software here under a fixed, enforced flow. Full detail is in `RULEBOOK.md`; this file is the binding short version. The machine also enforces the key steps automatically (`.claude/checks/`) — they are NOT optional.

## The loop — one Linear issue at a time, in this EXACT order
1. **PULL** the next issue from Linear → set *In Progress* → re-read it.
2. **CLARITY CHECK** — if the issue is vague, **PARK it** (note why) and move to the next. Never build on a guess.
3. **BRANCH** for this one issue.
4. **CODE** only what the issue asks. No scope drift.
5. **TEST** — it works AND automated tests pass.
6. **SHIP** — run `.claude/checks/ship.sh <ISSUE-ID>`. This runs tests → checks standards → deploys to the server → confirms live, all-or-nothing. You may NOT mark an issue done until ship.sh exits successfully.
7. **CLOSE** the Linear issue + post a sign-off comment: *"what I did / what I didn't do."*
8. **NEXT** issue automatically. NEVER ask "what's next."

## Hard rules
- One **flat** Linear issue per task. NEVER create sub-tickets.
- **"Done" = merged AND deployed live AND confirmed.** Coded-but-not-deployed is NOT done, because it isn't live.
- Don't beg per issue — work the approved batch straight through.
- Pause only for a **BIG** decision (costs money / irreversible / unclear). Small decisions: you decide.
- Plain English to the user. Never ask the user a technical question.

## When stuck (overnight)
- **Code bug** → try up to 3 times, then PARK it and continue with the rest.
- **Decision / risky / costs money** → PARK immediately for the user's OK.
- **Several issues fail in a row, OR the deploy breaks** → STOP the whole run (something is broken at the base).

## Every app MUST include — checked before ship
- **Lists/tables:** pagination · search box on top · filters · sortable columns · total count · loading state · friendly empty state · clean formatting.
- **Forms/actions:** confirm before delete · success message · friendly errors (never a raw crash) · input validation · consistent file/photo uploads.
- **Look & feel:** responsive · consistent design · accessible · dark mode · fast · consistent date/number formatting.
- **Login/security:** accounts (signup/login/logout) · roles · encrypted passwords + safe reset · secrets out of code + HTTPS · auto-logout on inactivity.
- **Every app:** notifications · profile & settings page.
- **CRUD for any "thing"** = list + create + read + update + delete, with all of the above, role-aware, PLUS bulk actions, export, import, item history.

## Under the hood
Organized & documented · reuse don't repeat · built to grow · deploy straight to live (no staging — no users yet).

## Why these never get skipped
The machine backs these rules: tests run automatically and block on red, files auto-format, and `ship.sh` is the only path to "done." Don't rely on memory — run the checks.
