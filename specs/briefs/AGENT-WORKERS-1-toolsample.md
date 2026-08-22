# Agent workers 1/10 — `ToolSample`: keep whole vendor answers

Part 1 of the Agent Workers build. **Read `specs/AGENT-WORKERS.md` §A first — it is the design.**
Owner-facing plan: <https://claude.ai/code/artifact/cbbddb85-2021-40b3-9943-44a051754e16>
(Linear issue to be filed when the Linear login is renewed; this file is the brief meanwhile.)

## Why this is first

Today the only record of a vendor answer is `ToolCall.result` — pretty-printed, then truncated to
2000 characters (`api/src/tools/service-actions.service.ts:39`; `ToolKnowledgeService.fieldsOfTruncated()`
exists because that truncation bites). Workers cannot be tested or repaired against that, and a repair
must **never** re-call a vendor, because that spends real credits. Everything else in the design
stands on this.

## Build

- **`ToolSample` model** exactly as in §A: `payload Bytes` (gzipped, **never base64** — the nightly
  backup `services/backup/vps-backup-snapshot.sh:11` copies the whole DB and base64 adds ~33%),
  `arguments` masked and uncapped, `argsHash` (sha256 of normalised args), `kind` `good|failing`,
  `bytes`, `note`, indexes `[actionId, kind, createdAt]`, `[agentId]`, `[argsHash]`.
- **New `maskPayload()` — do NOT reuse `redact()`** (`service-actions.service.ts:456`): it hard-truncates
  at `RECORDED_ARGS_CHARS = 4000` (`:465`) and masks by *key name* only, so it would miss a phone number
  in `wa_id`, an email in `from`, a bio, a caption. Mask by key name **and** value shape (email,
  E.164 / long digit runs, the existing secret regex). Keep structure and types so a test still
  exercises the real shape.
- **Written from `runDetailed()`**, on success only, after masking, and **opt-in per service** — start
  with the social read actions the workers actually need.
- **Never sampled**: Vault actions; any action whose answer carries message bodies (WhatsApp, Gmail,
  chat); anything from a gated send; anything in a new `NO_SAMPLE_SERVICES` set.
- **Caps, as consts in one place**: `RAW_MAX = 256 KB` (before gzip); `SAMPLE_MAX_BYTES = 1 MB` stored
  (bigger → stored truncated and marked `usable:false`); `PER_ACTION_GOOD = 5`;
  `PER_AGENT_FAILING = 10`; `TOTAL_BUDGET_MB = 100`.
- **Eviction sweep** (one `setInterval`, beside the others): per-`(actionId, argsHash)` beyond
  `PER_ACTION_GOOD`, per-agent failing beyond `PER_AGENT_FAILING`, then oldest-first to hold
  `TOTAL_BUDGET_MB`. Never delete a sample referenced by a worker's `samples/index.json` (that file
  does not exist yet — leave the hook, no dead code).
- **`auto_vacuum = INCREMENTAL`** set in the migration and `PRAGMA incremental_vacuum` run by the
  sweep. Without it SQLite never returns evicted space to the disk and the backup grows for ever.
- **`ToolSampleService.replay(actionId, argsHash?)`** → the parsed payload. Replay must never reach a
  provider.

## Acceptance (WHEN / MUST)

- WHEN a real social read runs, a sample MUST be stored whose parsed payload deep-equals the
  provider's answer minus masked fields.
- WHEN a Vault action or a WhatsApp conversation read runs, NO sample MUST be written.
- WHEN a 3 MB answer arrives, it MUST be stored truncated and marked unusable for tests.
- WHEN 50 MB of samples are evicted, the database file on disk MUST actually shrink.
- WHEN `replay()` is called, NO provider call MUST occur (asserted with a spy).
- `maskPayload()` MUST be unit-tested against a fixture containing an email, an E.164 number, a bare
  12-digit number, a caption, and a key named `token`.
- Existing behaviour MUST be untouched: `ToolCall` rows, credits, gates and the plan runner all work
  exactly as before (their tests stay green).

## Notes

- SQLite, `strict:false`, optional ctor deps LAST and `?.`-guarded.
- No UI in this piece; `UI_ROUTES` may be omitted from ship.sh.
