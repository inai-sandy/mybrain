/**
 * Rules that MORE THAN ONE prompt needs, written once (BEA-1544).
 *
 * The reason this file exists, in his words: *"Fixing every file the way you want to do, but it's
 * creating more and more and more problems."* He was right, and the tool question is the clean proof.
 *
 * He was asked "which connected tools should the agent use?" — twice in one morning, by two different
 * prompts. BEA-1542 fixed the chat builder. BEA-1543 fixed the goal writer. Each fix was correct and
 * neither fixed the bug, because the rule was written out longhand in both places and a third prompt
 * could be written tomorrow with a third wording.
 *
 * `CLAUDE.md` already says this and I read past it: *"A rule with two call sites should be a function
 * with one. This has now cost FOUR real runs."*
 *
 * So: a prompt rule that two prompts need lives HERE, and they import it. Changing his mind then costs
 * one edit, in one place, and cannot half-apply.
 */

/**
 * Never ask the owner which tool to use.
 *
 * He does not know the action ids — `svc:reddit.subreddit` means nothing to him — so the question can
 * only stall him. Everything a prompt is shown is already connected and usable, and the tool-call log
 * says which ones actually work: `svc:reddit.subreddit` had 35 successes while a look-alike Composio
 * integration he never linked sat next to it reporting "not connected".
 *
 * Asking about the JOB is always right. Asking about the plumbing never is.
 */
export const CHOOSE_TOOLS_RULE = `CHOOSE THE TOOLS YOURSELF. Never ask the owner which connected tool, service or action to use — he does not know the ids, and everything you are shown is already connected and usable. Where two could do the job, take the one that has actually worked. Name your choice in the reply in plain words ("searching Reddit, writing a new Google Sheet, messaging you on WhatsApp"). Ask about the JOB — what counts, how much, when it runs, where the result goes — never about the plumbing. If nothing you were shown can do a part of the job, say that plainly instead of asking him to pick.`;

/**
 * Let the vendor rank, when the vendor can rank.
 *
 * His Reddit agent wanted "the top 100 posts of the week by score". Codex called the search with
 * `sort: 'new'` and set out to rank them itself — which means fetching EVERY post of the week, an
 * unbounded job. It ran to the 11-page ceiling, got 71 posts, could not honestly call them the top
 * 100, and stopped to ask him. Eleven credits and an afternoon for nothing.
 *
 * The same action's own fact card lists `sort: ['relevance', 'new', 'top', 'comment_count']`.
 * `sort: 'top'` with `timeframe: 'week'` returns the week's best already ranked — the first page IS
 * the answer. It picked the one option that makes the job impossible while the one that makes it
 * trivial sat beside it in the same list.
 *
 * Written as a rule rather than a checker on purpose: a checker clever enough to catch this would be
 * clever enough to block good plans, and a rule cannot false-alarm.
 */
export const RANK_AT_THE_SOURCE_RULE = `RANKING: when the job asks for the top / best / most / highest N of something, ask the SOURCE to sort that way and take the first N — never fetch by newest (or by relevance) and rank them yourself. Sorting yourself means fetching everything before you can know the top of it, which is unbounded and will hit the page limit and produce nothing. Read the action's own parameters: if it offers a sort or an order, use the one the job asks for. Only rank in your own code when the source genuinely cannot sort that way — and if it cannot, say so plainly rather than fetching everything and hoping. THEN SORT WHAT YOU FETCHED, YOURSELF, before you use it: the source's sort decides WHICH items you get, your own sort decides the ORDER they go out in. Sorting a few hundred items you already hold costs nothing. Never ASSERT that the source returned them in order and fail when it did not — vendors do not promise an exact order across pages, and a run that throws away good data because the order was imperfect has produced nothing out of something.`;

/**
 * Ask for everything when you need everything, and never invent a limit.
 *
 * His ESP32 agent stopped twice on the same wall. It asked for the default 11 pages, hit the ceiling,
 * and then told him — on his phone — *"only 70 usable posts before the 15-page cap and still had more
 * results"*. There is no 15-page cap. `kit.callAll` defaults to 11 and the run's own step said
 * `11 pages`. It narrated a number it never read, and both times the option it offered him ("raise the
 * paging limit") was one it could have taken itself.
 *
 * `pages: 'all'` already exists and is what this job wanted: it fetches until the SOURCE runs out
 * (backstopped well above any real result set). That matters beyond convenience — a fetch that ends
 * because the vendor ran out can honestly say "that was everything", which is what lets the
 * "everything there was is not the same as not enough" rule finish the job instead of asking him.
 * A fetch that stops at a page ceiling can never know, so it must ask. The ceiling created the
 * question.
 */
export const FETCH_EVERYTHING_RULE = `PAGES: when the job needs a COMPLETE set — "all of them", "the top N of a week/month", "everything that matched" — pass \`pages: 'all'\` to \`kit.callAll\`. It fetches until the source itself runs out, so the run can tell "that was everything" (finish and write it) from "I stopped early" (which it must ask about). Do not pass a number and then treat running out of pages as a shortage — that turns a finished job into a question. And NEVER state a page limit, a cap or a count you have not read: the kit's answer tells you how many pages you actually used and whether the source ran out. Say those numbers, or say none.`;
