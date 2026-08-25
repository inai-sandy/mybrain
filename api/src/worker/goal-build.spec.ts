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
    expect(t).not.toContain('svc:notion');
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
