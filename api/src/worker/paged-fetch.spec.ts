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
