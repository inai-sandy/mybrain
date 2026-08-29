/**
 * Rules that EVERY brief handed to Codex needs, written once (BEA-1544).
 *
 * A build brief, a repair brief and a goal build brief are three different documents, but some of what
 * they tell Codex is the same in all of them — and it was copied into each by hand. Copies drift. The
 * sandbox rule below is the one that matters: it is the sentence that keeps a Codex session from
 * writing outside the folder it was given, and it existed in two files with no test tying them
 * together. A repair that quietly lost it would have had more freedom than the build it repairs.
 *
 * The reason this file exists is his: *"Fixing every file the way you want to do, but it's creating
 * more and more problems."* A rule in one place cannot half-apply.
 */

/**
 * What a Codex session may write, and nothing else.
 *
 * `worker-runner.server.js` enforces the real boundary — no shell, fixed argv, cwd pinned to the
 * version folder — so this is the instruction, not the guarantee. But an instruction that says one
 * thing in a build and another in a repair is worth nothing, which is why it is a constant.
 */
export const SANDBOX_RULE =
  'Do not write any other file, do not create a git repo, do not install anything.';

/**
 * Never claim a link that does not exist.
 *
 * Written for the message a worker sends him. A sketch that ends "Read it here: <link>" when no link
 * was ever produced reads as success and is a lie — and he is the only reader, so nobody else catches
 * it. Say what there is, or say there is nothing.
 */
export const NO_FAKE_LINK_RULE =
  '**Never promise a link you do not have.** If no link was produced, say what you made and where it is in plain words, or say plainly that there is nothing to open — never end with a link that does not exist.';

/**
 * What a check (trial) answers, and that the answer is success.
 *
 * Every new agent runs once inside a CHECK before it goes live (BEA-1553): writes held, sends held,
 * questions auto-answered. Nothing told Codex those rules, so every first build met the trial blind
 * and reacted however the model guessed that day — his YouTube agent's v3 asked for the held sheet's
 * link 1,610 times in one check, and then failed it. The versions piling up on a new agent were not
 * fixing the job; they were groping toward how the check behaves. This constant tells the model the
 * rules of the room it is tested in, so the first version passes more often.
 */
export const TRIAL_RULE =
  '**In a check (a trial run), a held write IS success.** During a check, `kit.writeSheet` and `kit.writeDocument` answer `{ trial: true, url: null, id: null }` and `kit.notify` answers `{ trial: true }` — the write was held on purpose, and that answer means the step is DONE. Verify nothing about it, ask nobody for a link or an id, and carry on to `kit.finish`. A real run never answers `trial: true`. Write a test for this shape too: drive the worker with those trial answers and prove it finishes without asking anything.';
