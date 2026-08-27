import { readFileSync } from 'fs';
import { join } from 'path';
import { goalBuildPrompt } from './goal-build';

/**
 * A LIST IS NEVER ONE CALL (BEA-1495).
 *
 * His ESP32 agent asked Reddit for the top 100 posts of the week, sent `{subreddit, sort}` — no time
 * filter, one call — got 6 posts, and stopped. The answer it received contained
 * `after: "t3_1vz262m"`, the cursor to the next page, and the action's own card said
 * "paging: cursor via after". Every fact was in front of it.
 *
 * The cause was not judgement: the Social road has paged this exact tool for months, and a
 * goal-built program could not reach a line of that code. `kit.callAll` carries it across.
 */
describe('a goal-built program can page', () => {
  const flatten = (t: string) => t.replace(/\s+/g, ' ');
  const kit = () => readFileSync(join(__dirname, 'kit/kit.js'), 'utf8');
  // These files are hand-wrapped prose, so a phrase can straddle a newline. Compare on the words.
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  const doc = () => flat(readFileSync(join(__dirname, 'kit/KIT.md'), 'utf8'));

  it('the kit offers callAll, and it posts to the same route as a plan source', () => {
    const t = kit();
    expect(t).toContain('async callAll(actionId, args, o2)');
    // The SAME route and therefore the same fetcher — a second paging implementation is the thing
    // this whole issue exists to avoid.
    expect(t).toMatch(/callAll[\s\S]{0,400}post\('tool'/);
  });

  it('the parts-box document tells a program to use it, with the real failure as the reason', () => {
    const t = doc();
    expect(t).toContain('kit.callAll');
    expect(t).toContain('do not call once');
    expect(t).toContain('t3_1vz262m');
    expect(t).toContain('Never write your own paging loop');
  });

  it('the build prompt says a list is never one call, and names the real run', () => {
    const t = flat(goalBuildPrompt({
      job: { id: 'j1', name: 'ESP32 weekly top posts' },
      goal: 'Every week put the top 100 posts from r/esp32 into a Google Sheet and WhatsApp me the link.',
      transcript: [{ who: 'you', text: 'Top 100 posts of the week from r/esp32.' }],
      tools: [{ actionId: 'svc:reddit.subreddit', name: 'Subreddit posts', card: '# Subreddit posts\npaging: cursor via "after"' }],
      kit: { version: '1', js: '// kit', doc: '# KIT' },
      version: 1,
    } as any));
    expect(t).toContain('A list is never one call');
    expect(t).toContain('kit.callAll');
    expect(t).toContain('t3_1vz262m');
    // The count check is the half that turns a short fetch into a caught bug rather than a small sheet.
    expect(t).toContain('is not a small sheet');
  });
});

/**
 * EVIDENCE A REPAIR CAN ACTUALLY SEE (BEA-1495).
 *
 * The repair of that agent ran with NO evidence and deleted an ask-the-owner path instead of fixing
 * the fetch. The reason: `evidenceOf` looked each answer's action up on the job's PLAN, a goal-built
 * job has no plan, so `actionId` was empty and `keepEvidence` dropped everything on
 * `if (!f.actionId) continue`.
 */
describe('a failed run leaves evidence even without a plan', () => {
  const svc = () => readFileSync(join(__dirname, 'worker-repair.service.ts'), 'utf8');
  const ctl = () => readFileSync(join(__dirname, 'worker.controller.ts'), 'utf8');

  it('the answer carries its own action id', () => {
    // Both roads: the single call and the paged fetch.
    expect(ctl()).toMatch(/ok: !!r\.ok,[\s\S]{0,900}actionId,/);
    expect(ctl()).toMatch(/fetchPaged[\s\S]{0,600}actionId,/);
  });

  it('the repair prefers the answer\'s own id over the plan lookup', () => {
    expect(svc()).toContain("actionId: answer.actionId || actionOf(job, sourceId)");
  });

  it('a paged fetch is not invisible to the repair', () => {
    expect(svc()).toContain("e.fn !== 'fetchPaged'");
  });

  it('a short fetch counts as rows, so a succeeded-but-short call is evidence too', () => {
    // 6 of 100 came back ok:true. If only errored calls count, the cause is unreadable.
    expect(svc()).toContain('answer.table?.rows?.length ?? answer.count ?? 0');
  });
});

/**
 * fetchSource IS FOR PLANS, AND A GOAL AGENT HAS NONE (BEA-1498).
 *
 * A repair rewrote a working `kit.callAll` into `kit.fetchSource` and broke the agent outright:
 * a goal-built job has no plan and therefore no sources, so that call can only ever answer
 * "This job has no source called …". Nothing in the parts box, the prompt, or the error itself said
 * so — the repair had no way to learn, and would have made the same choice again.
 */
describe('a goal-built program is told not to reach for fetchSource', () => {
  const flatten = (t: string) => t.replace(/\s+/g, ' ');
  const doc = () => flatten(readFileSync(join(__dirname, 'kit/KIT.md'), 'utf8'));
  const ctl = () => flatten(readFileSync(join(__dirname, 'worker.controller.ts'), 'utf8'));

  it('the parts box says it plainly, next to the call itself', () => {
    const t = doc();
    expect(t).toContain('only for a job that has a PLAN');
    // Asserted in fragments: the source is hand-wrapped markdown, so a blockquote marker can land
    // in the middle of a phrase once whitespace is flattened.
    expect(t).toContain('kit.callAll(actionId, args,');
    expect(t).toContain('instead: same paging, same de-duping');
  });

  it('the build prompt tells a goal-built program it has no plan', () => {
    const t = flatten(goalBuildPrompt({
      job: { id: 'j1', name: 'ESP32 weekly top posts' },
      goal: 'Top 100 posts from r/esp32 each week into a Sheet.',
      transcript: [{ who: 'you', text: 'top 100 of the week' }],
      tools: [{ actionId: 'svc:reddit.subreddit', name: 'Subreddit posts', card: '# Subreddit posts' }],
      kit: { version: '1', js: '// kit', doc: '# KIT' },
      version: 1,
    } as any));
    expect(t).toContain('never call `kit.fetchSource`');
    expect(t).toContain('no sources');
  });

  it('the error tells a plan-less job what to use instead', () => {
    // The old message just said "no source called X" — true, useless, and unlearnable.
    expect(ctl()).toContain('This job has no plan and no sources');
    expect(ctl()).toContain('kit.callAll(');
  });

  it('a job that DOES have sources still gets the list of them', () => {
    expect(ctl()).toContain('Its sources are:');
  });
});

/**
 * EXHAUSTED IS NOT SHORT (BEA-1502).
 *
 * His ESP32 agent finally paged properly: 5 pages, 90 posts, and the fetcher said "that was
 * everything". r/esp32 had 90 top posts that week — 100 did not exist. The program failed the run
 * anyway, because a shortfall was the only thing it knew how to see.
 *
 * A fetch that did not finish is a failure. A vendor that gave everything it had is a question.
 */
describe('a short fetch is not always a failed one', () => {
  const flatten = (t: string) => t.replace(/\s+/g, ' ');
  const prompt = () => flatten(goalBuildPrompt({
    job: { id: 'j1', name: 'ESP32 weekly top posts' },
    goal: 'Top 100 posts from r/esp32 each week into a Sheet.',
    transcript: [{ who: 'you', text: 'top 100 of the week' }],
    tools: [{ actionId: 'svc:reddit.subreddit', name: 'Subreddit posts', card: '# Subreddit posts' }],
    kit: { version: '1', js: '// kit', doc: '# KIT' },
    version: 1,
  } as any));

  it('names both reasons and separates them', () => {
    const t = prompt();
    expect(t).toContain('The fetch did not finish');
    expect(t).toContain('The vendor gave everything it had');
  });

  it('says which signal to read, so it is decidable rather than a guess', () => {
    expect(prompt()).toContain('that was everything');
  });

  it('asks him rather than failing, and rather than passing 90 off as 100', () => {
    const t = prompt();
    expect(t).toContain('ask him');
    expect(t).toContain('Do not fail');
    // The other half: a quiet 90-for-100 would be the "never invent a result" failure in disguise.
    expect(t).toContain('say the real number');
  });

  it('carries the real run, so the rule does not read as invented caution', () => {
    expect(prompt()).toContain('that subreddit had 90 posts that week');
  });
});
