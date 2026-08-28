import { RANK_AT_THE_SOURCE_RULE } from '../agent/prompt-rules';
import { goalBuildPrompt } from './goal-build';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Let the source rank (BEA-1546).
 *
 * His goal: "the top 100 r/esp32 posts of the week by vote score". Codex called Reddit's search with
 * `sort: 'new'` and set out to rank them itself — which means fetching EVERY post of the week before
 * you can know its top. It ran to the 11-page ceiling, got 71 posts, could not honestly call them the
 * top 100, and stopped to ask him. Eleven credits for nothing, and the repair that followed promoted
 * a v2 with the same `sort: 'new'` still in it.
 *
 * The action's own fact card lists `sort: ['relevance', 'new', 'top', 'comment_count']`. `sort: 'top'`
 * with `timeframe: 'week'` returns the week's best already ranked — one or two pages and done.
 */
describe('the ranking rule', () => {
  it('tells it to sort at the source and take the first N', () => {
    expect(RANK_AT_THE_SOURCE_RULE).toMatch(/ask the SOURCE to sort/i);
    expect(RANK_AT_THE_SOURCE_RULE).toMatch(/never fetch by newest/i);
  });

  // The reason, not just the instruction — a rule with its reason attached survives being edited.
  it('says why sorting yourself cannot work', () => {
    expect(RANK_AT_THE_SOURCE_RULE).toMatch(/unbounded|fetching everything/i);
    expect(RANK_AT_THE_SOURCE_RULE).toMatch(/page limit/i);
  });

  // It must not become "never rank in code" — sometimes the source genuinely cannot sort.
  it('still allows ranking in code when the source cannot sort', () => {
    expect(RANK_AT_THE_SOURCE_RULE).toMatch(/genuinely cannot sort/i);
    expect(RANK_AT_THE_SOURCE_RULE).toMatch(/say so plainly/i);
  });

  it('points it at the action\'s own parameters', () => {
    expect(RANK_AT_THE_SOURCE_RULE).toMatch(/action's own parameters/i);
  });
});

describe('both briefs carry it', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8');

  it('the goal build brief — the road that built his Reddit agent', () => {
    expect(read('goal-build.ts')).toContain('RANK_AT_THE_SOURCE_RULE');
  });

  it('the plan build brief', () => {
    expect(read('build-brief.ts')).toContain('RANK_AT_THE_SOURCE_RULE');
  });

  // One wording, imported — never written out twice (BEA-1544).
  it('neither writes the rule out longhand', () => {
    for (const f of ['goal-build.ts', 'build-brief.ts']) {
      expect(read(f)).not.toContain('ask the SOURCE to sort');
    }
  });

  it('the rule really reaches the brief Codex is handed', () => {
    const brief = goalBuildPrompt({
      job: { id: 'a1', name: 'Top posts' },
      goal: 'the top 100 posts this week by score',
      transcript: [],
      tools: [],
      kit: { version: '1', js: '', doc: '' },
      version: 1,
    } as any);
    expect(String(brief)).toContain('ask the SOURCE to sort');
  });
});
