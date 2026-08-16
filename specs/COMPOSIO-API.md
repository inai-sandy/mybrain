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
Paginate with `next_cursor`.

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
