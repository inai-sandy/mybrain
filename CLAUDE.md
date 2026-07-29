# Project rules — Claude MUST follow these

You build software here under a fixed, enforced flow. Full detail is in `RULEBOOK.md`; this file is the binding short version. The machine also enforces the key steps automatically (`.claude/checks/`) — they are NOT optional.

## The loop — one Linear issue at a time, in this EXACT order
1. **PULL** the next issue from Linear → set *In Progress* → re-read it.
2. **CLARITY CHECK** — if the issue is vague, **PARK it** (note why) and move to the next. Never build on a guess.
3. **BRANCH** for this one issue.
4. **CODE** only what the issue asks. No scope drift.
5. **TEST** — it works AND automated tests pass.
6. **REVIEW** — run the `code-reviewer` agent on this issue's diff. Fix every **critical/high** finding before shipping (3 attempts, then PARK). Low/medium: fix if quick, else note it in the sign-off. Never ship past a critical finding.
7. **SHIP** — run `.claude/checks/ship.sh <ISSUE-ID> "<ISSUE-ID>: <what you did>"`. One command does the whole finish: tests → standards → **commit** → deploy → confirm live → **merge into the default branch** → **push to GitHub** → log it → delete the work branch → assert nothing is left uncommitted or unpushed. All-or-nothing. You may NOT mark an issue done until it exits 0.
8. **CLOSE** the Linear issue + post a sign-off comment: *"what I did / what I didn't do"* — include the commit sha that ship.sh printed.
9. **NEXT** issue automatically. NEVER ask "what's next."

## Hard rules
- One **flat** Linear issue per task. NEVER create sub-tickets.
- **"Done" = committed AND pushed AND deployed live AND confirmed.** Coded-but-not-deployed is NOT done. Live-but-not-committed is NOT done either — that work is one `docker build` away from vanishing.
- **Never `git commit` by hand during the loop, and never close an issue without ship.sh.** ship.sh is the only path to done; doing it by hand is how steps get skipped.
- Don't beg per issue — work the approved batch straight through.
- Pause only for a **BIG** decision (costs money / irreversible / unclear). Small decisions: you decide.
- Plain English to the user. Never ask the user a technical question.

## When stuck (overnight)
- **Code bug** → try up to 3 times, then PARK it and continue with the rest.
- **Decision / risky / costs money** → PARK immediately for the user's OK.
- **Several issues fail in a row, OR the deploy breaks** → STOP the whole run (something is broken at the base).

## Standards — checked before ship
**Always, on every issue that touches the UI or data:**
- **Lists/tables:** pagination · search box on top · filters · sortable columns · total count · loading state · friendly empty state · clean formatting.
- **Forms/actions:** confirm before delete · success message · friendly errors (never a raw crash) · input validation · consistent file/photo uploads.
- **Look & feel:** responsive (check phone **and** laptop widths) · consistent design · accessible · dark mode · fast · consistent date/number formatting.
- **Secrets & connection:** secrets never in code or git · always HTTPS.

**When the project actually has them** (skip if it doesn't — don't invent scope):
- **Accounts & roles:** signup/login/logout · roles · encrypted passwords + safe reset · auto-logout on inactivity.
- **Notifications · profile & settings page.**

**CRUD for any "thing"** = list + create + read + update + delete, with the Always items above, role-aware, PLUS bulk actions, export, import, item history.

## Under the hood
Organized & documented · reuse don't repeat · built to grow · deploy straight to live (no staging — no users yet).

## Why these never get skipped
The machine backs these rules: tests block on red, files auto-format, dangerous commands are blocked, and `ship.sh` is the only path to "done" — it will not let you finish with work uncommitted or unpushed. Don't rely on memory — run the checks.

---
<!-- PROJECT-CONTEXT:START — generated. Refresh this section whenever the project gains a service,
     a dependency, a route group, or a new deploy step. Do not hand-edit the sections above it. -->
## This project

**My Brain** — the owner's private second brain, live at **https://mybrain.1site.ai** (single user, cookie session, no public signup).

**Layout**
- `api/` — NestJS + Prisma on **SQLite** (`/app/data/mybrain.db` in the container). One module per feature under `api/src/<feature>/`; register new ones in `api/src/app.module.ts`.
- `web/` — React + Vite + Tailwind PWA. Pages in `web/src/pages/`, shared components in `web/src/ui/`, routes in `web/src/App.tsx`.
- `.claude/checks/` — the enforced flow. `preflight.sh` (read-only), `ship.sh` (the ONLY path to done), `deploy.sh`, `healthcheck.sh`.

**Running the checks**
- Tests: `( cd api && npm test )` then `( cd web && npm test )` — the value in `.claude/checks/test-command`.
- Types: `npx tsc --noEmit` in each of `api/` and `web/`. Do this before shipping; it catches more than the tests.

**The agent engine**
Agent runs execute on **Codex directly** via a host runner at `http://172.18.0.1:8765` (`/home/sandy/codex-runner/server.js`) — Hermes was removed in 2026-06. The runner only takes a prompt; it offers **no per-run tool gating**, which is why the toolbox is enforced on our side (`flows-runner` refuses a step, the prompt declares the allowed set). My Brain's own tools reach the model as a host **MCP server** (`~/.codex/config.toml [mcp_servers.mybrain]`), mounted statically for every run. **Exa's hosted MCP** (`[mcp_servers.exa]` → `https://mcp.exa.ai/mcp`) is mounted the same way so engine turns can search too; it runs on Exa's free tier with no key, and Codex cannot send Exa's `x-api-key` header (it only supports a bearer token), so a paid key would need `mcp-remote` in front of it.

**Web search is NOT an engine turn.** `web_search` / `web_read` (Tavily) and `web_search_meaning` (Exa) are direct HTTP calls in `api/src/tools/web-research.service.ts`, dispatched inside `runNode` — they are deliberately absent from `AGENT_TOOLS`. Putting them back would hand the choice of *how* to search to the model, which is the bug that made a research run cite 2021 figures for 2025. They never fall back to the model: a failure fails the step with its reason.

**Things that will bite a fresh session**
- **Flow tool ids are load-bearing.** `flows-runner.service.ts` dispatches on them (`AGENT_TOOLS`, `toolPrompt`). Renaming an id silently breaks every flow already saved in the database. Adding ids is safe, but an id not in `AGENT_TOOLS` falls through to a plain model call — fine for reasoning, wrong for a lookup, because it will invent the answer.
- **One tool catalog.** `api/src/tools/tool-catalog.service.ts` (`GET /api/tools/catalog`) is the single source for the agent toolbox, the builder chat and the Flows canvas. Do not start a second list.
- **Optional deps go LAST in a constructor** — many spec files build services positionally with fewer args. Guard optional delegates with `?.` too: spec harnesses pass partial Prisma stubs, so `this.prisma.flow.findMany` throws where `this.prisma.flow?.findMany?.()` degrades.
- **A job's last run can be an agent run OR a flow run.** Anything deep — and every voice job — runs as a flow. Query both or the UI will say "never ran".
- **Deploying kills in-flight runs.** `ship.sh` does `docker rm -f`, and the boot reconciler fails anything left `running`. Don't ship while a long run you care about is going.
- **QA the UI for real.** Playwright-core + cached Chromium at `~/.cache/ms-playwright/chromium-1228/`; log in via `POST /api/auth/login` with the creds in `.claude/checks/secrets.env` and set the `mb_session` cookie. Check **390 and 1180**, and assert `document.documentElement.scrollWidth === window.innerWidth` — a single wide table can push the whole page sideways.
- Prompts are editable at runtime (Settings → Prompts); defaults live in `api/src/prompts/prompts.service.ts`. Add a key to the union type AND the registry.

<!-- PROJECT-CONTEXT:END -->

