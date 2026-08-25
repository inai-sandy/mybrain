/**
 * The traps we already know, written down for the machine (BEA-1368).
 *
 * These are the hand-kept facts that a spec cannot say and a log cannot show — the ones we wrote
 * for humans in `specs/SCRAPECREATORS-API.md` and `specs/COMPOSIO-API.md` and then kept tripping
 * over anyway. The know-how card (`ToolKnowledgeService`) merges them in as `notes[]`, and a note
 * can also pin a paging or cost fact the spec leaves out (popular search: 12 per page).
 *
 * Rules for adding one:
 *  - only a FACT that was seen live or read in the vendor's own text — never a guess;
 *  - plain English, one sentence, the way you would tell a colleague;
 *  - keyed as narrowly as it is true: an exact action id, a prefix (`svc:instagram.search_`), or a
 *    whole service (`instagram`). A service note lands on every action of that service.
 */

export type KnowledgeNote = {
  /** Exact `svc:` id, a `svc:<service>.<prefix>*` glob (trailing `*` only), or a bare service slug. */
  match: string;
  notes: string[];
  /** A paging fact the spec does not state. Filled in only where the card has nothing better. */
  paging?: { how?: 'cursor' | 'page' | 'none'; pageSize?: number; cap?: number };
  /** A cost fact in the vendor's own words, when the spec's prose is missing or unclear. */
  cost?: { credits?: number; note?: string };
};

export const KNOWLEDGE_NOTES: KnowledgeNote[] = [
  // ---- Instagram (ScrapeCreators) ----------------------------------------------------------
  {
    match: 'instagram',
    notes: [
      'Instagram has no location or country filter on any endpoint. "In India" has to come from India hashtags, India creators and reading captions — recall over precision.',
      'Cached answers cost 0 credits — a repeat of the same call inside their cache window is free.',
    ],
  },
  {
    match: 'svc:instagram.search_popular',
    notes: [
      'Popular search: posts carry NO date — not usable for "last 30 days".',
      '12 posts per page; the opaque cursor from the answer pages further with the same query.',
      'Keys are lowercase on Instagram\'s side ("Home automation" → 404, "home automation" → posts). We lowercase the query before sending.',
      'A query with no popular page answers "Instagram does not have a popular page for that query" (0 credits) — an empty answer, not an outage.',
      'Owners of popular posts are a good creators finder: posts[].owner.username are real, active accounts on the topic — as the FINDER of a creators-first block ("smart home india" → mmlites, smartr.spaces, ahasmart, whitelion.in…) it gave 82 dated posts while hashtag and reels search were down (seen live 2026-08-18). Use argsFrom { "handle": "owner.username" }.',
    ],
    paging: { how: 'cursor', pageSize: 12 },
    cost: { credits: 1 },
  },
  {
    match: 'svc:instagram.search_hashtag',
    notes: [
      'Google-indexed: it can answer not_found ("No posts found") for EVERY query for hours while their index is out — recorded as a failed call, 0 credits. Plan for an empty day.',
      'The cursor is the Google results page number and stops at 11 — about 11 pages per search at most.',
      'Posts are dated (taken_at) and carry like/comment/view counts and the owner — rich enough for a sheet. like_count can be -1 (hidden).',
      'A leading # and capital letters are the same tag; we strip the # and lowercase before sending.',
    ],
    paging: { how: 'cursor', cap: 11 },
  },
  {
    match: 'svc:instagram.reels_search',
    notes: [
      'Google-indexed: it can answer not_found ("No scrapeable reels found") for every query during their outages — 0 credits, treat as an empty answer.',
      'Pages by number 1..11; page 12 or more is a 400.',
    ],
    paging: { how: 'page', cap: 11 },
  },
  {
    match: 'svc:instagram.search_profiles',
    notes: [
      'Google-indexed profile search — same 11-page ceiling and the same outage pattern as hashtag search.',
      'Matches names/handles, not topics — many look-alike/dead accounts: "smart home india" answered smart.home_india, smart_home_india, smart.homes.india… with 0–20 followers and no post in the last 30 days — 10 creators, 50 posts, 0 kept (seen live 2026-08-18). Sample before trusting it as a finder and judge the accounts real (followers, recent posts); Popular Search\'s post owners are a better finder for a topic.',
    ],
    paging: { how: 'cursor', cap: 11 },
  },
  {
    match: 'svc:instagram.search',
    notes: ['Instagram-native search (users): kept working on 2026-08-17 while the Google-indexed searches were down. 1 credit.'],
  },
  {
    match: 'svc:instagram.post',
    notes: ['`region` here is only where the proxy sits (a 2-letter country code) — it does not filter anything.'],
  },
  {
    match: 'svc:instagram.post_comments',
    notes: ['Costs 15 credits per call (they fetch the replies for every comment) — comments on 50 posts is 750 credits, not 50.'],
    cost: { credits: 15 },
  },

  // ---- TikTok --------------------------------------------------------------------------------
  {
    match: 'tiktok',
    notes: ['`region` on TikTok search, feed and video endpoints only moves the proxy — it does NOT filter to that country. The real country filters are creatorCountry/audienceCountry on popular creators, and `region` on the TikTok Shop endpoints.'],
  },
  {
    match: 'svc:tiktok.creators_popular',
    notes: ['This one really filters by country: creatorCountry and audienceCountry are 2-letter codes, plus a follower-count band. Pages by number.'],
  },
  {
    match: 'svc:tiktok.video_transcript',
    notes: ['The video must be under 2 minutes; with use_ai_as_fallback=true it costs an extra 10 credits on top of the usual 1.'],
    cost: { note: '1 credit, +10 when use_ai_as_fallback=true' },
  },
  {
    match: 'svc:tiktok.user_audience',
    notes: ['Audience demographics cost 26 credits per call.'],
    cost: { credits: 26 },
  },
  {
    match: 'svc:tiktok.shop*',
    notes: ['`region` on TikTok Shop is a real region filter, but the vendor says only US is reliable right now.'],
  },

  // ---- Facebook / Google / LinkedIn / YouTube --------------------------------------------------
  {
    match: 'svc:facebook.ad_library_search_ads',
    notes: ['`country` is a REAL filter here — one 2-letter code per call — with start_date/end_date on impressions.'],
  },
  {
    match: 'svc:facebook.ad_library_company_ads',
    notes: ['`country` and `language` really filter here; you need the company\'s ad-library page id first (search for companies).'],
  },
  {
    match: 'svc:google.company_ads',
    notes: ['`region` really filters here (defaults to anywhere). 1 credit for ids only; 25 credits per call when get_ad_details=true.'],
    cost: { note: '1 credit for ids only, 25 with get_ad_details=true' },
  },
  {
    match: 'svc:google.search',
    notes: ['`region` (2-letter code) really shows results from that country; date_posted filters; pages 1..11 only.'],
    paging: { how: 'page', cap: 11 },
  },
  {
    match: 'svc:linkedin.search_posts',
    notes: ['Google-indexed like Instagram hashtag search: dated filter, cursor is the page number and stops at 11.'],
    paging: { how: 'cursor', cap: 11 },
  },
  {
    match: 'svc:linkedin.ads_search',
    notes: ['`countries` is a real filter — a comma-separated list of 2-letter codes.'],
  },
  {
    match: 'svc:youtube.search',
    notes: ['`region` only moves the proxy (2-letter code) — it does not restrict results to that country. uploadDate is a real time filter.'],
  },

  // ---- Composio: Google ------------------------------------------------------------------------
  {
    match: 'svc:googlesheets.create_google_sheet1',
    notes: ['The answer has spreadsheet_id but NO url — build it: https://docs.google.com/spreadsheets/d/<id>.'],
  },
  {
    match: 'svc:googlesheets.batch_update',
    notes: ['Writes a block of values from first_cell_location (e.g. A1) on sheet_name; header row + rows in one call.'],
  },
  {
    match: 'svc:googledrive.find_file',
    notes: ['A name in `query` is NOT a filter — it returned 100 unrelated files for name = \'x\'. Check the returned name before acting on it, and never find-then-delete by name.'],
  },
  {
    match: 'svc:googledrive.get_file_metadata',
    notes: ['Returns only id, name and mimeType — the link and size come from a by-name search.'],
  },
  {
    match: 'svc:googlecalendar.events_list',
    notes: ['Has a stale default timeMax — always pass timeMax yourself.'],
  },
  {
    match: 'svc:gmail.fetch_emails',
    notes: [
      'The list comes back in ARRIVAL order, not date order — re-sort on messageTimestamp.',
      // Recorded from a real build (BEA-1473): a program asked for a whole day of mail with full
      // bodies in one call and the vendor refused the lot with HTTP 413 — no rows, no partial
      // answer. Its own guidance is the fix, so it is written here where the next build will read it.
      // Measured, not guessed (BEA-1475). Two real builds died here. The first passed `maxResults`
      // (wrong case) so the cap was dropped entirely; the second got the cap right — `max_results:50`
      // with a sensible query — and still died, because `verbose:true` pulls the full body of every
      // one of those 50 at once. The size limit is on the WHOLE response, so a correct limit plus a
      // verbose flag is still too much.
      'HTTP 413 "payload is too large" refuses the WHOLE response — no rows, no partial answer. Two things cause it, and the second is the one that surprises people: (1) no cap, so pass max_results (25 is safe); (2) verbose:true, which pulls the full body of EVERY message in the page. `verbose:true` with max_results:50 is over the limit even with a tight query.',
      'The way that works: list first with verbose:false (or ids_only:true) to get senders, subjects and timestamps cheaply, decide which messages you actually care about, and only then fetch bodies for those few. Do not fetch 50 bodies to keep 3.',
      // The third build to die here (BEA-1477), and the subtlest: it MEANT to pass verbose:false, and
      // its own argument helper skipped the value for being falsy, so the flag never went out and the
      // default took over. What actually reached Gmail was {user_id, max_results:100,
      // include_spam_trash:false} — no verbose anywhere.
      'verbose DEFAULTS TO TRUE — leaving it out is the EXPENSIVE choice, not the safe one. Pass verbose:false explicitly. Watch for this in your own code: `false` is falsy, so any helper that skips empty or missing values drops it silently and you get full bodies without ever seeing why.',
    ],
  },

  // ---- WhatsApp (our own gateway, BEA-1384) ----------------------------------------------------
  {
    match: 'whatsapp',
    notes: [
      'These reach REAL phones from the shared business number. Every send stops at the can\'t-undo gate; reads run freely.',
      'Free text only works inside 24 hours after the person last messaged us. To start a conversation, or to reach anyone cold, use send_template with an APPROVED template — never promise free text to a cold contact.',
      'No credits are charged — WhatsApp calls never touch the Social daily ceiling.',
    ],
  },
  {
    match: 'svc:whatsapp.send_text',
    notes: [
      'Only works inside the 24h window after the person last messaged us. Outside it, WhatsApp accepts the send and Meta refuses it a few seconds later — plan send_template instead for anyone who may be cold.',
      'A "sent" answer is not "delivered" — check get_conversation or the message status, not just the send result.',
    ],
  },
  {
    match: 'svc:whatsapp.send_template',
    notes: [
      'Works any time (no 24h window), but ONLY with a template whose Meta status is APPROVED — call list_templates first and use the exact name.',
      'Meta can still refuse it seconds AFTER a "sent" answer (engagement pacing on an unengaged recipient). Treat "sent" as "handed to Meta", not "on the phone".',
    ],
  },
  {
    match: 'svc:whatsapp.send_list',
    notes: ['24h window only, and it says so instead of pretending. Max 10 rows; a row title is cut at 24 characters — put the fuller wording in the description.'],
  },
  {
    match: 'svc:whatsapp.send_rfq',
    notes: ['ONE SHOT to EVERY vendor in a KIOT category — there is no confirm step at the gateway and no undo. Double-check the category and items; never use this for anything but a real vendor RFQ.'],
  },
  {
    match: 'svc:whatsapp.delete_template',
    notes: ['Deletes the template from Meta and the gateway in one go. It cannot be undone, and a deleted name cannot be resubmitted to Meta for 30 days.'],
  },
  {
    match: 'svc:whatsapp.check_replies',
    notes: ['Made for polling: pass the `latest` timestamp from the previous answer as `since` next time.'],
  },
  {
    match: 'svc:whatsapp.list_templates',
    notes: ['Shows each template\'s LIVE Meta status — only APPROVED ones can be sent. Meta can silently reclassify a template\'s category after approval.'],
  },
];

/** The notes that apply to one action id, most specific first, without repeats. */
export function notesFor(actionId: string, service: string, all: KnowledgeNote[] = KNOWLEDGE_NOTES): KnowledgeNote[] {
  const id = String(actionId || '');
  const svc = String(service || '').toLowerCase();
  const rank = (n: KnowledgeNote): number => {
    const m = n.match;
    if (m === id) return 0;
    if (m.endsWith('*') && id.startsWith(m.slice(0, -1))) return 1;
    if (!m.includes(':') && m === svc) return 2;
    return -1;
  };
  return all
    .map((n) => ({ n, r: rank(n) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.n);
}
