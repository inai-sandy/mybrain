/**
 * The biggest request body this app accepts (BEA-1455).
 *
 * Express defaults to 100 KB, and nothing had ever noticed — everything crossing that line was
 * small: Instagram posts, a table of rows, a plan. The owner's first agent that summarises EMAIL
 * died on it: nine real messages with their bodies is comfortably past 100 KB, so the run fetched
 * cleanly, read the rows with the tool's own recipe, and then failed with "request entity too large"
 * the moment it handed them back for the thinking step.
 *
 * Big enough for a busy day of real mail, small enough that a runaway worker is still stopped. This
 * is a single-user app and the worker road's traffic never leaves the machine.
 *
 * It lives in its own file so a test can read it **without importing `main.ts`** — importing that
 * runs `bootstrap()` and binds port 8080, which is exactly how the first version of this made two
 * suites fight over a port.
 */
export const BODY_LIMIT = '25mb';
