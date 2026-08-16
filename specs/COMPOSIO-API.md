# Composio REST — verified shapes (2026-08-16)

Every call below was run for real against our account with our key and the response recorded. Build
against these, don't rediscover them, and don't trust Composio's docs pages — they are wrong about
several things (see `specs/TOOLS.md`).

Base: `https://backend.composio.dev/api/v3`
Auth: header `x-api-key: $COMPOSIO_API_KEY` (already in `.claude/checks/secrets.env`)

**Canonical user id: the literal string `mybrain-owner`.** Single-user app — keep it behind one
constant so a future multi-tenant instance changes it in one place.

## Live state in the account
- `github` → `mybrain-owner` → **ACTIVE** (connected 2026-08-16, use this to prove things work)
- `gmail` ×2 → `pg-test-41c13fd3-…` → ACTIVE. Leftovers from Composio's playground, **not ours** —
  ignore them, but note they prove two accounts of one toolkit under one user id is allowed.
- GitHub auth config already exists: **`ac_nS0qc-uWKKqP`**. Reuse an existing auth config for a
  toolkit; only create one when there is none.

## List toolkits
`GET /toolkits?limit=N` → `{ items[], total_items: 1209, total_pages, next_cursor, current_page }`
Paginate with `next_cursor`. **`limit=500` is honoured** — all 1,209 in three round trips (~2.3s)
instead of thirteen (~10s). Each item carries the same `meta` as the single-toolkit call, including
`meta.categories: [{id,name}]` (a toolkit is usually in two or three), so one walk gives you the
whole browse list AND the category counts.

### How the 1,209 actually split (counted live, 2026-08-16)
| | count | what it means for the UI |
|---|---:|---|
| Composio-managed auth | **121** | one-click Connect works |
| Bring your own app/key | **1,056** | the COMMON case, not Vercel's oddity — needs a real form |
| No auth at all | **32** | must NOT be offered a Connect button (see below) |

Biggest categories: developer-tools 341 · marketing-automation 110 · analytics 110 ·
artificial-intelligence 89 · crm 74. 88 distinct categories in all.

⚠️ **`GET /toolkits/categories` is unusable** — it answers with duplicate ids and names that no
toolkit is filed under. Build a category list by counting `meta.categories` across the toolkits.

⚠️ **70 of the logo URLs 404.** Always render a fallback tile.

## One toolkit
`GET /toolkits/<slug>` →
```
{ "name":"Gmail", "slug":"gmail", "auth_schemes":["OAUTH2"],
  "composio_managed_auth_schemes":["OAUTH2"],
  "meta":{ "tools_count":61, "triggers_count":2, "description":"…", "logo":"…" } }
```
`meta.tools_count` / `meta.triggers_count` are the **only** trustworthy counts. Read them at run
time; never hard-code.

**`composio_managed_auth_schemes` may be empty** (Vercel is). That means no one-click connect — the
owner must supply their own OAuth credentials. Handle it; don't offer a Connect button that cannot work.

## List / search tools in a toolkit
`GET /tools?toolkit_slug=github&search=<text>&limit=N` → `{ items:[{ slug, name, … }] }`

⚠️ **`search` is weak — it is not semantic.** Searching "authenticated user" returned
`GITHUB_ACCEPT_A_REPOSITORY_INVITATION` first. Do **not** rely on this endpoint to pick the right
action for a user's sentence. Use Composio's session tool-search (`COMPOSIO_SEARCH_TOOLS`) for
intent → action, and use this endpoint only for listing and for the catalog.

## One tool, exactly (verified live 2026-08-16, BEA-1347)
`GET /tools/<TOOL_SLUG>` → the single action, with `input_parameters` — the JSON schema its
arguments are filled from — plus `output_parameters`, `description` and `tags`.

**This is how an action is looked up, never the list endpoint's `search`.** Asked for
`GITHUB_GET_THE_AUTHENTICATED_USER`, `GET /tools?toolkit_slug=github&search=…` answers with
`GITHUB_CREATE_OR_UPDATE_A_SECRET_FOR_THE_AUTHENTICATED_USER` first. A step that found its own
action by searching would quietly run a different one and report it as done.

## Create an auth config (Composio-managed OAuth)
`POST /auth_configs`
```json
{"toolkit":{"slug":"github"},
 "auth_config":{"type":"use_composio_managed_auth","name":"mybrain-github"}}
```
→ `{"toolkit":{…},"auth_config":{"id":"ac_…","auth_scheme":"OAUTH2","is_composio_managed":true}}`

## Connect an account — the trap
`POST /connected_accounts` **is deprecated for managed OAuth** and returns HTTP 400:
> "Creating connections on this endpoint for Composio-managed OAuth auth configs is no longer
> supported. Use POST /api/v3/connected_accounts/link instead."

Use:
`POST /connected_accounts/link` with `{"auth_config_id":"ac_…","user_id":"mybrain-owner"}` →
```json
{"link_token":"lk_…","redirect_url":"https://connect.composio.dev/link/lk_…",
 "expires_at":"…","connected_account_id":"ca_…"}
```
**`redirect_url` expires in ~12 minutes.** Mint it fresh on demand; never cache or persist it.
For a second account of the same toolkit, the SDK equivalent needs `allowMultiple: true`.

## Bring-your-own auth — the two halves (verified live 2026-08-16, BEA-1346)

`auth_config_details[0].fields` has **two** halves and the required fields sit in one or the other
depending on the auth mode. Sending one half to the other's endpoint silently does nothing.

| mode | example | required fields live in | where they go |
|---|---|---|---|
| `OAUTH2` | twitter: `client_id`, `client_secret`, `generic_id` | `auth_config_creation` | the auth config's `credentials`, then the normal `/link` redirect |
| `API_KEY` | vercel: `bearer_token` · openai: `generic_api_key` | `connected_account_initiation` | the **account**, not the auth config — and there is no browser step at all |

Custom auth config (either mode) — `credentials: {}` is accepted and correct for `API_KEY`:
```json
POST /auth_configs
{"toolkit":{"slug":"vercel"},
 "auth_config":{"type":"use_custom_auth","name":"mybrain-vercel","authScheme":"API_KEY","credentials":{}}}
```
Then, for `API_KEY` only, create the account directly — **`POST /connected_accounts` is only
deprecated for Composio-MANAGED OAuth, and it is the one endpoint that takes a key**:
```json
POST /connected_accounts
{"auth_config":{"id":"ac_…"},
 "connection":{"user_id":"mybrain-owner",
   "state":{"authScheme":"API_KEY","val":{"status":"ACTIVE","bearer_token":"…"}}}}
```
→ `201 {"id":"ca_…","status":"ACTIVE","redirect_url":null}`. Both the account and the auth config
delete cleanly (`DELETE /connected_accounts/<id>`, `DELETE /auth_configs/<id>` → `{"success":true}`).

## No-auth toolkits cannot be connected — and must not be asked
`POST /auth_configs` for a `no_auth: true` toolkit answers **HTTP 400**:
> Cannot create an auth config for toolkit "hackernews" because it does not require authentication.
> …works without an auth config. You can use its tools directly without creating a connected account.

Both `use_custom_auth` and `use_composio_managed_auth` are refused. So a Connect button on one of
these 32 can only ever produce an error — say "ready to use" instead.

## List connections
`GET /connected_accounts?limit=N` → `{ total_items, items:[{ id, user_id, status,
toolkit:{slug}, auth_config:{id,…} }] }`. Filterable by `user_ids` and `statuses`.

## Execute an action — verified working
`POST /tools/execute/<TOOL_SLUG>`
```json
{"user_id":"mybrain-owner","arguments":{"per_page":3}}
```
→ `{ "successful": true, "error": null, "data": { … } }`

Proven live with `GITHUB_ACTIVITY_LIST_REPO_S_STARRED_BY_AUTHENTICATED_USER`, which returned real
repositories. **Check `successful` and surface `error`** — a failed action still returns HTTP 200,
so a naive `res.ok` check would report success on a failure.

Pass `connected_account_id` as well when a toolkit has more than one connected account.

Proven again end to end on 2026-08-16 (BEA-1347) through a real flow step:
`GITHUB_GET_THE_AUTHENTICATED_USER` (no arguments) and `GITHUB_LIST_REPOSITORY_ISSUES` (arguments
filled from its schema) both returned real data, and a bad repo name came back as
`successful:false` with GitHub's own `{"message":"Not Found",…}` body inside `error` — HTTP 200
throughout, which is why the verdict is only ever read from `successful`.
