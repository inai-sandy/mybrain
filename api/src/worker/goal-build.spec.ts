import { goalBuildFiles, goalBuildPrompt, GoalBuildInputs } from './goal-build';

/**
 * THE BUILD, standing on the conversation and the goal (BEA-1464).
 *
 * The owner, after his first real message arrived broken in three separate ways:
 *
 *   *"Why are we declaring something and asking Codex to do that thing? Let us discuss everything in
 *   the chat and send the same chat transcription to Codex, and let Codex take the action."*
 *
 * He was right, and the evidence was unarguable: every defect in that message came from a structure
 * the app had written — the plan, the contract, the message template — and none from Codex's code.
 *
 * So the strongest assertions below are ABSENCES. If a plan, a contract or a fill-in template ever
 * reappears in this prompt, the app has started deciding the work again.
 */

const inputs = (over: Partial<GoalBuildInputs> = {}): GoalBuildInputs => ({
  job: { id: 'j1', name: 'Nightly email summary' },
  goal: 'Read his Gmail at 22:00 and send him the messages that need him, as summaries in the WhatsApp message itself.',
  transcript: [
    { who: 'you', text: 'Send me my important emails every night.' },
    { who: 'assistant', text: 'Which mailbox?' },
    { who: 'you', text: 'Gmail. On WhatsApp — I want to read them there, not click a link.' },
  ],
  tools: [{ actionId: 'svc:gmail.fetch_emails', name: 'Fetch emails', card: '# Fetch emails\nWhat it does: reads a mailbox.' }],
  kit: { version: '1', js: '// kit', doc: '# KIT' },
  version: 1,
  ...over,
});

describe('what lands in the folder', () => {
  it('is the goal, the conversation and the parts box — and nothing else', () => {
    const files = goalBuildFiles(inputs());
    expect(Object.keys(files).sort()).toEqual(['GOAL.md', 'conversation.md', 'kit/KIT.md', 'kit/kit.js']);
  });

  it('carries the goal verbatim', () => {
    expect(goalBuildFiles(inputs())['GOAL.md']).toContain('as summaries in the WhatsApp message itself');
  });

  it('carries every turn of the conversation, in order', () => {
    const c = goalBuildFiles(inputs())['conversation.md'];
    expect(c).toContain('Send me my important emails every night');
    expect(c).toContain('Which mailbox?');
    expect(c).toContain('not click a link');
    expect(c).toContain('nothing left out');
  });

  it('writes NO plan, NO contract and NO brief', () => {
    // The three things the app used to decide on Codex's behalf. Their absence is the feature.
    const keys = Object.keys(goalBuildFiles(inputs()));
    expect(keys).not.toContain('plan.json');
    expect(keys).not.toContain('contract.json');
    expect(keys).not.toContain('BRIEF.md');
    expect(keys).not.toContain('brief.json');
  });
});

describe('what Codex is asked', () => {
  const p = () => goalBuildPrompt(inputs());

  it('gives it the goal and says the conversation is the specification', () => {
    expect(p()).toContain('as summaries in the WhatsApp message itself');
    expect(p()).toContain('The conversation and the goal are the specification');
    expect(p()).toContain('Design the rest yourself');
  });

  it('says WHY there is no plan or contract, so nobody helpfully adds one back', () => {
    expect(p()).toContain('each one quietly changed what he had asked for');
  });

  it('asks for two files, and does not dictate the shape of the work', () => {
    const t = p();
    expect(t).toContain('worker.mjs');
    expect(t).toContain('worker.test.mjs');
    // The old prompt specified the call order — fetch, merge, shape, expect, write, notify, finish.
    // That sequence was the eight-box plan wearing a different hat.
    expect(t).not.toMatch(/kit\.merge|kit\.shape\(|then merge the/i);
  });

  it('makes Codex check its own result against its own goal', () => {
    const t = p();
    expect(t).toContain('Check your own work against the goal');
    expect(t).toContain('Write that check in your own code, in your own terms');
    // …and the app's own helper is offered, never imposed.
    expect(t).toContain('a convenience and not a requirement');
  });

  it('keeps the two promises he would notice if they broke', () => {
    const t = p();
    // Never a quiet success. This really happened and cost 101 credits.
    expect(t).toContain('Never report success for a result that does not meet the goal');
    expect(t).toMatch(/90 answers fetched, 0 rows\s+recognised/);
    // A quiet day is a good day — the fix he asked for after a Sunday with no important mail.
    expect(t).toContain('A genuinely empty day is not a failure');
  });

  it('hands the words to Codex, with no template anywhere', () => {
    const t = p();
    expect(t).toContain('you write the words');
    expect(t).toContain('there are no blanks to fill');
    expect(t).not.toContain('<angle brackets>');
    expect(t).not.toContain('hole to fill');
  });

  it('teaches the two things that broke his first real message', () => {
    const t = p();
    expect(t).toContain('A count is not a summary');
    expect(t).toContain('Never promise a link you do not have');
  });

  it('says the web is open with no restriction, building and running', () => {
    expect(p()).toContain('The open web, with no restriction');
  });

  it('sends only the tools he named', () => {
    const t = p();
    expect(t).toContain('svc:gmail.fetch_emails');
    // Checked on the TOOLS SECTION, not the whole prompt. The prose elsewhere names
    // `svc:notion.create_comment` as the worked example of a matcher picking wrongly (BEA-1470), and
    // an example is not a tool being handed over. The thing this test protects is that no fact card
    // he did not ask for is shipped.
    const section = t.slice(t.indexOf('## '));
    expect(section).not.toMatch(/### `svc:notion/);
    expect(t).not.toContain('svc:instagram');
  });

  it('tells Codex its closing paragraph reaches HIM', () => {
    const t = p();
    expect(t).toContain('what you assumed, and anything you');
    expect(t).toContain('**He reads this**');
  });

  it('keeps green tests as the one hard gate', () => {
    const t = p();
    expect(t).toContain('Green tests are the only way this goes live');
    expect(t).toMatch(/lying about it is worse than\s+failing/);
  });

  it('tells it to PIN the exact ids rather than match on words at run time (BEA-1470)', () => {
    const t = p();
    expect(t).toContain('Pin the exact action ids while you build');
    // Grounded in what actually happened, not a rule from nowhere: a matcher searching Notion for
    // "create" + "page" chose `create_comment`, because a Notion comment is attached to a page.
    expect(t).toContain('svc:notion.create_comment');
    expect(t).toContain('a pinned id is a thing a test can assert');
  });

  it('carries the whole document of each tool his words name (BEA-1472)', () => {
    const t = goalBuildPrompt(inputs({ toolDocs: [{ service: 'whatsapp', text: '# Whatsapp\n\n- `svc:whatsapp.send_text` — Send a message.' }] }) as any);
    expect(t).toContain('The tools this conversation names, in full');
    expect(t).toContain('svc:whatsapp.send_text');
    // With the reason attached, so nobody trims it as noise later.
    expect(t).toContain('do not type one from');
    expect(t).toContain('svc:whatsapp.send_message');
  });

  it('says nothing about them when his words named none', () => {
    expect(p()).not.toContain('The tools this conversation names, in full');
  });

  /**
   * THE LAST FAILURE IS EVIDENCE, NOT BACKGROUND (BEA-1478).
   *
   * Three rebuilds died on the same Gmail 413 and each time the answer was another general note
   * about Gmail. The third cause was not about Gmail at all — one call site in one program never
   * sent a flag. A note teaches every future agent something true; it cannot see a bug in the code
   * it is replacing. The sent arguments can, because they show what left the building rather than
   * what the code appeared to do.
   */
  it('shows what broke last time, and the arguments that really went out', () => {
    const t = goalBuildPrompt(inputs({
      lastFailure: {
        error: 'Gmail could not do that: HTTP 413 — payload too large.',
        steps: ['done — Checked pinned actions', 'failed — Gmail could not do that'],
        calls: [{ action: 'svc:gmail.fetch_emails', args: '{"user_id":"x","max_results":100}', error: 'HTTP 413' }],
      },
    }) as any);
    expect(t).toContain('What happened when this last ran');
    expect(t).toContain('HTTP 413');
    expect(t).toContain('"max_results":100');
    // The sentence that makes the evidence usable rather than decorative.
    expect(t).toContain('A flag missing from that list was never sent');
  });

  it('says nothing about a last failure when there has not been one', () => {
    expect(p()).not.toContain('What happened when this last ran');
  });

  it('says which version is live so it does not think it is replacing nothing', () => {
    expect(goalBuildPrompt(inputs({ previousVersion: 3 }))).toContain('runs on v3 today');
  });
});

/**
 * THE THREE PLACES THAT MUST AGREE (BEA-1464, and the lesson of BEA-1462).
 *
 * "Can this job have a program, and is its program still right?" is asked by the build, by the
 * Settings screen, and by the dispatcher. It has now been got wrong twice — once because the rule
 * lived in three copies, once because two of them hashed different things — and each time a job
 * with a green, promoted worker quietly ran the old way for ever while its own screen said it was
 * fine. A goal-built job is the newest chance to make that mistake a third time, because it has no
 * plan at all: the old rule refuses it for having no sources, and the old hash would hash an empty
 * shape identically for every such job.
 */
describe('a goal-built job answers the same in all three places', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WorkerBuildService } = require('./worker-build.service');
  const { goalHash } = require('./goal-build');

  const goal = { version: 2, text: 'Read his Gmail at 22:00 and send the summaries to WhatsApp.', tools: [] };
  // A job with NO plan columns at all — exactly what the new road produces.
  const job = { id: 'j1', areaId: 'ar1', name: 'Nightly email summary', tools: [], toolArgs: null };
  const withGoal = { goals: { approved: async () => goal }, briefs: undefined };
  const without = { goals: { approved: async () => null }, briefs: undefined };

  it('is buildable BECAUSE it has a goal, though it has no sources', () => {
    // The old rule's own verdict on this job, for contrast: it refuses it outright.
    expect(WorkerBuildService.whyNotCompilableFor(job)).toMatch(/nothing to fetch from yet/i);
    return expect(WorkerBuildService.prototype.whyNotBuildable.call(withGoal, job)).resolves.toBe('');
  });

  it('is hashed on the goal, not on an empty plan', async () => {
    const h = await WorkerBuildService.prototype.buildHashFor.call(withGoal, job);
    expect(h).toBe(goalHash(2, goal.text));
    expect(h).toMatch(/^goal:/);
  });

  it('two different goals do not hash the same — an empty plan would have', async () => {
    const other = { goals: { approved: async () => ({ ...goal, version: 3, text: 'Something else entirely.' }) } };
    const a = await WorkerBuildService.prototype.buildHashFor.call(withGoal, job);
    const b = await WorkerBuildService.prototype.buildHashFor.call(other, job);
    expect(a).not.toBe(b);
  });

  it('approving a NEW goal is what marks the worker stale — and only that', async () => {
    const same = await WorkerBuildService.prototype.buildHashFor.call(withGoal, job);
    const again = await WorkerBuildService.prototype.buildHashFor.call(withGoal, { ...job, name: 'renamed' });
    expect(again).toBe(same); // a rename is not a rebuild
  });

  it('a job with no goal still answers the old way, so nothing live changes', async () => {
    expect(await WorkerBuildService.prototype.whyNotBuildable.call(without, job)).toMatch(/nothing to fetch from yet/i);
    expect(await WorkerBuildService.prototype.buildHashFor.call(without, job)).toBe('');
  });
});

/**
 * …and the door itself (BEA-1464, found by re-reading what I had just shipped).
 *
 * `build()` and `state()` were still calling the raw `whyNotCompilableFor`. A goal-built job has no
 * sources, so both refused it — the build would have thrown "this job has nothing to fetch from yet"
 * before ever reaching the new road, and the screen would have said the job cannot have a worker at
 * the same moment the dispatcher was happy to run one. That is the BEA-1462 shape exactly, and it
 * was live for the length of one commit.
 */
describe('every door asks the goal-aware question', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs');
  const { join } = require('path');

  it('no call site reads the raw rule any more except the rule itself', () => {
    const src = readFileSync(join(__dirname, 'worker-build.service.ts'), 'utf8');
    // Exactly TWO uses are legitimate, and both are fallbacks reached only after the goal has
    // already been checked and found absent: one inside `whyNotBuildable`, one inside
    // `buildHashFor` (which does its own goal lookup first and must not pay for a second one).
    // Any third use is a door that forgot about goals.
    const uses = src.split('WorkerBuildService.whyNotCompilableFor(job)').length - 1;
    expect(uses).toBe(2);
    expect(src).toContain('static whyNotCompilableFor');
    // build(), state() and buildHashFor() all go through the goal-aware one.
    expect(src.split('this.whyNotBuildable(job)').length - 1).toBeGreaterThanOrEqual(2);
  });
});

/**
 * WHOSE CLOCK? (BEA-1486)
 *
 * He said it plainly: *"Server is using wrong time. i am in IST timezone."*
 *
 * His timezone was set in the app all along — `tasks.tz = Asia/Kolkata` — and the build prompt
 * mentioned time zones exactly zero times. So every program was written against the server's UTC
 * clock and was five and a half hours out of step with his day. "Every day at 22:00" means nothing
 * until somebody says whose 22:00.
 */
describe('the program is written against HIS clock', () => {
  it('names his timezone and warns that new Date() is not his time', () => {
    const t = goalBuildPrompt(inputs({ timezone: 'Asia/Kolkata' }) as any);
    expect(t).toContain('He is in **Asia/Kolkata**');
    expect(t).toContain('is NOT his time');
    // With a way to actually do it, not just a warning.
    expect(t).toContain("timeZone: 'Asia/Kolkata'");
    // And the consequence, so it is not trimmed as boilerplate.
    expect(t).toContain('will be wrong for him for part of every');
  });

  it('says nothing at all when no timezone has been set — never assumes one', () => {
    const t = goalBuildPrompt(inputs() as any);
    expect(t).not.toContain('His clock');
  });
});

/**
 * ASK HIM, DO NOT STOP (BEA-1488).
 *
 * He ran it and the run died on its last step: *"Notion created a page but did not return a page id,
 * so I cannot add the report safely."* — reporting failure for a page that had been created
 * successfully seconds earlier. His instruction: *"It should ask me rather than stop it."*
 *
 * Waiting is free (the worker exits and resumes from its journal), so giving up is never the cheap
 * option it looks like.
 */
describe('a surprise mid-run is a question, not a dead end', () => {
  const t = () => goalBuildPrompt(inputs() as any);

  it('carries his instruction and puts kit.fail last', () => {
    expect(t()).toContain('It should ask me rather than stop it');
    expect(t()).toContain('is the last resort');
  });

  it('says the waiting is free, so stopping is never the cheaper option', () => {
    expect(t()).toMatch(/two-day wait costs nothing|Waiting is free/);
  });

  it('still tells it to work things out itself first — this must not become ask-about-everything', () => {
    // The rule is an escalation ladder. Without this line it would become a program that asks him
    // things it could have read, which is its own kind of failure.
    expect(t()).toContain('Never ask him something the program could read');
  });

  it('names the real failure so the rule is not read as boilerplate', () => {
    expect(t()).toContain('created his Notion page');
  });
});

/**
 * THE ENVELOPE (BEA-1488) — the actual cause of that run.
 *
 * Gmail hands back `{messages:[...]}`; Notion's create-page hands back `{data:{id,url,…}}`. Same
 * `data` field on the kit, two different conventions underneath. Codex wrote a sound reader for each
 * shape it was told about and found nothing in the one it was not.
 */
describe('the program is warned that answers are not shaped alike', () => {
  const t = () => goalBuildPrompt(inputs() as any);

  it('names both real shapes and the unwrap', () => {
    expect(t()).toContain('some actions wrap their answer in an envelope and some do not');
    expect(t()).toContain('answer?.data ?? answer');
  });

  it('states the consequence, so it is not trimmed as generic advice', () => {
    expect(t()).toContain('did not return a page id');
  });
});

/**
 * TRIALS CAN WRITE NOW (BEA-1491) — and the judgement comes with the context to use it.
 *
 * He was asked directly, with the irreversible-send risk spelled out, and chose "everything, no
 * exceptions". So no rule here refuses an action for what it does. What the prompt owes Codex instead
 * is the two facts it needs to choose well — which is the difference between trusting it and hoping.
 */
describe('a build may try writes, and is told what that means', () => {
  const t = () => goalBuildPrompt(inputs() as any);

  it('says plainly that the read-only restriction is gone', () => {
    expect(t()).toContain('now includes writes');
    expect(t()).toContain('You\ncan try **any** call while you build');
  });

  it('names why it changed, so it does not read as a loosening for its own sake', () => {
    expect(t()).toContain('four builds in a row failed');
  });

  it('gives the two facts judgement needs, as guidance and not as a rule', () => {
    const text = t();
    expect(text).toContain('Prefer things that can be taken back');
    expect(text).toContain('cannot be taken back');
    // Guidance, explicitly — the moment this becomes a refusal we are back to guessing shapes.
    expect(text).toContain('Nothing will stop you');
  });
});
