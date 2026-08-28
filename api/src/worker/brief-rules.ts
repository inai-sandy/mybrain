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
