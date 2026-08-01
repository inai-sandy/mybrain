import { FlowRunnerService } from '../flows/flows-runner.service';

/**
 * BEA-1259 — the news steps must run OUR code, never a model turn.
 *
 * CLAUDE.md is explicit about the trap: a tool id the runner does not recognise falls through to a
 * plain model call. For a lookup that is the worst possible failure, because the model does not
 * error — it cheerfully invents the answer. A flow step called "Collect the AI news" would return a
 * fluent description of collecting the news while the database stayed empty, and the run would be
 * marked done.
 *
 * These tests were written because a negative control caught that nothing covered it: removing the
 * dispatch entirely left the whole suite green.
 */

function runner(news?: any) {
  // Positional build, matching the other flow specs. `news` is the LAST optional dependency.
  return new FlowRunnerService(
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    news,
  );
}

const node = (refId: string) => ({ data: { kind: 'tool', label: 'x', refId } });

describe('the news tools run real code (BEA-1259)', () => {
  it('each id calls its own pipeline step, and returns what that step reported', async () => {
    const calls: string[] = [];
    const news = {
      collect: async () => { calls.push('collect'); return 'Stories found: 40'; },
      writeToday: async () => { calls.push('write'); return 'Wrote AI News Daily No. 3'; },
      flagToday: async () => { calls.push('flag'); return '3 of 40 look worth digging into'; },
    };
    const r: any = runner(news);
    expect(await r.runNode(node('news_collect'), '')).toContain('Stories found: 40');
    expect(await r.runNode(node('news_write'), '')).toContain('No. 3');
    expect(await r.runNode(node('news_flag'), '')).toContain('worth digging into');
    expect(calls).toEqual(['collect', 'write', 'flag']);
  });

  it('never reaches the model — no model call is made for a news step', async () => {
    // If this ever regresses, the step still "succeeds" and the edition is fiction.
    const askModel = jest.fn(async () => 'I have collected the news for you!');
    const r: any = runner({ collect: async () => 'real work', writeToday: async () => 'x', flagToday: async () => 'y' });
    r.askModel = askModel;
    await r.runNode(node('news_collect'), '');
    expect(askModel).not.toHaveBeenCalled();
  });

  it('FAILS the step when the pipeline is missing, rather than inventing an edition', async () => {
    const r: any = runner(undefined);
    await expect(r.runNode(node('news_collect'), '')).rejects.toThrow(/not available on this server/);
  });

  it('a failing step throws its real reason instead of degrading to a model answer', async () => {
    const r: any = runner({ collect: async () => { throw new Error('the feed returned 503'); } });
    await expect(r.runNode(node('news_collect'), '')).rejects.toThrow(/503/);
  });
});
