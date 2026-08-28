import { FETCH_EVERYTHING_RULE } from '../agent/prompt-rules';
import { goalBuildPrompt } from './goal-build';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Ask for everything when you need everything (BEA-1548).
 *
 * His ESP32 agent stopped twice on the same wall. It asked for the default 11 pages, hit the ceiling,
 * and told him on his phone: *"only 70 usable posts before the 15-page cap and still had more
 * results"*. There is no 15-page cap — `kit.callAll` defaults to 11, and the run's own step said
 * `11 pages`. It narrated a limit it had never read, and offered him an action ("raise the paging
 * limit") that it could have taken itself.
 *
 * `pages: 'all'` already existed. It fetches until the SOURCE runs out — which is what lets a run say
 * "that was everything" and finish, instead of stopping at a ceiling where it can never know.
 */
describe('the fetch-everything rule', () => {
  it("tells it to ask for 'all' when the job needs a complete set", () => {
    expect(FETCH_EVERYTHING_RULE).toMatch(/pages: 'all'/);
    expect(FETCH_EVERYTHING_RULE).toMatch(/until the source itself runs out/i);
  });

  // The reason the ceiling is the problem: a fetch stopped by a cap can never know if more existed.
  it('explains why a page ceiling turns a finished job into a question', () => {
    expect(FETCH_EVERYTHING_RULE).toMatch(/that was everything/i);
    expect(FETCH_EVERYTHING_RULE).toMatch(/turns a finished job into a question/i);
  });

  it('forbids stating a limit it has not read', () => {
    expect(FETCH_EVERYTHING_RULE).toMatch(/NEVER state a page limit, a cap or a count you have not read/);
    expect(FETCH_EVERYTHING_RULE).toMatch(/Say those numbers, or say none/);
  });

  it('reaches the brief Codex is handed', () => {
    const brief = goalBuildPrompt({
      job: { id: 'a1', name: 'Top posts' },
      goal: 'the top 100 posts this week by score',
      transcript: [], tools: [],
      kit: { version: '1', js: '', doc: '' },
      version: 1,
    } as any);
    expect(String(brief)).toMatch(/pages: 'all'/);
  });

  it('is written once and imported, never copied', () => {
    for (const f of ['goal-build.ts', 'build-brief.ts']) {
      const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
      expect(s).toContain('FETCH_EVERYTHING_RULE');
      expect(s).not.toContain('until the source itself runs out');
    }
  });
});

describe('a question carries the pages it really used', () => {
  it('says pages, because that is the number the worker invents', () => {
    const s = fs.readFileSync(path.join(__dirname, 'worker.controller.ts'), 'utf8');
    expect(s).toMatch(/page\$\{cost\.calls === 1 \? '' : 's'\} fetched/);
    expect(s).toMatch(/What actually happened/);
  });
});
