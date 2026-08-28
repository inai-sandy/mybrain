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
