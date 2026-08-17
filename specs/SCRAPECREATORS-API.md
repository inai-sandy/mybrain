# ScrapeCreators — verified shapes (2026-08-17)

Every call below was run for real against the owner's account with his key and the response recorded.
Build against these. The marketing site says "36+ APIs"; **the OpenAPI spec has 178 endpoints across
29 platforms** — the spec is the only source of truth, and it is the source the provider generates from.

- Base: `https://api.scrapecreators.com`
- Auth: header `x-api-key: $SCRAPECREATORS_API_KEY` (in `.claude/checks/secrets.env`; one key per instance)
- Spec: `https://docs.scrapecreators.com/openapi.json` (OpenAPI 3.1, ~720 KB, 178 ops, 36 tags,
  every op has a summary + a 200 schema; 174/178 declare parameters, the other 4 take none)
- **Everything is a READ.** No endpoint writes to any platform. No gates apply.
- **No rate limits** on their side. Credits never expire. **Cached results cost 0.**

## Balance — verified
`GET /v1/account/credit-balance` → `{"success":true,"creditCount":25100,"message":"You have 25100 credits remaining."}`
Also `/v1/account/usage` and daily-usage endpoints exist for a spend view.

## Response envelope — verified on a real search
Every data call returns, at the top level:
```
success · credits_remaining · credits_charged · <endpoint-specific keys> · cursor (when paginated)
```
**Record `credits_charged` on every `ToolCall` row** — it is the honest cost, per call, from them.
`credits_charged` was **1** for the whole hashtag search below.

## Cost is NOT uniform — read it from the response, never assume 1
The spec states costs only in prose. Known from the spec: most calls **1**; Instagram post comments
**15**; TikTok video transcript **10**; TikTok audience demographics **26**; Google company ads **25**.
So a "get comments on 50 posts" agent is 750 credits, not 50. The daily ceiling exists for this.

## Instagram hashtag search — verified live
`GET /v1/instagram/search/hashtag?hashtag=smarthomeindia&date_posted=last-month` → HTTP 200,
8 posts, 1 credit, `cursor: null` (no more pages).
- `date_posted` enum: `last-hour | last-day | last-week | last-month | last-year`
- `media_type`: `all | reels`
- `cursor` = Google results page number, **cannot exceed 11** → hard cap of ~11 pages per search
- **No country filter exists.** "In India" is OUR filter step after fetching (hashtags, ₹, brands,
  city names, creator location). Recall, not precision.

Per post: `url, shortcode, caption, taken_at, like_count, comment_count, video_view_count,
video_play_count, is_video, video_url, display_url, is_ad, is_paid_partnership, is_affiliate,
location, product_type, owner{username, full_name, follower_count, post_count, is_verified,
is_private, profile_pic_url}`. `like_count` can be `-1` (hidden). Rich enough for a spreadsheet.

Sibling: `GET /v2/instagram/reels/search?query=<keyword>&date_posted=last-month&page=1..11`.

## The owner's example, proven end to end (three of four legs live)
1. ScrapeCreators hashtag search → 8 real Indian smart-home posts, 1 credit ✅
2. Composio `GOOGLESHEETS_CREATE_GOOGLE_SHEET1` `{title}` → spreadsheetId; then
   `GOOGLESHEETS_BATCH_UPDATE` `{spreadsheet_id, sheet_name:"Sheet1", values:[[...]], first_cell_location:"A1"}`
   → 9 rows written; read back with `GOOGLESHEETS_BATCH_GET` `{spreadsheet_id, ranges:["Sheet1!A1:I10"]}` ✅
   (create's `data` had `spreadsheetId` but **no URL** — build it: `https://docs.google.com/spreadsheets/d/<id>`)
3. WhatsApp: `AlertsService.runFinished()` → Postbox `sendText`, template fallback outside the 24h
   window. **Requires `alerts.whatsappNumber` in Settings** — it was empty; the owner is adding it. ✅ path
4. Scheduled agent: `Agent.schedule / tools / outputDest / notifyWhatsApp` all exist ✅

## Live state
Composio connections under `mybrain-owner`: github, gmail, googlecalendar, googledrive,
**googlesheets** (a duplicate from a double-tap was removed 2026-08-17), **notion**. Google Sheets is
the write target for spreadsheet outputs.

## Full endpoint list (generated from the spec, 178)
See `specs/SCRAPECREATORS-ENDPOINTS.md`. Regenerate from `openapi.json`; never hand-edit.

## ⚠️ Trap found during pre-build verification (2026-08-17)
`GOOGLEDRIVE_FIND_FILE` with `{"query":"name = 'x'"}` returned **100 unrelated files** — it did NOT
filter by name. Any code that "finds then deletes/updates" by name must verify the returned name
matches before acting, or use the file id it already holds. A blind find→delete loop would have
deleted the owner's real files. **Never script destructive Drive actions from a name search.**
Two harmless probe sheets named `preflight-probe-delete-me` / `Smart Home India — Instagram (proof…)`
are left in the owner's Drive on purpose.
