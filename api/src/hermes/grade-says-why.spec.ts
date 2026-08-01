import { HermesBridgeService } from './hermes-bridge.service';
import { GRADE_MAX_CHECKS, GRADE_MAX_TOKENS, parseGrade } from './grade';

/**
 * BEA-1247 — the grader went silent exactly when the answer got good.
 *
 * Its reply was capped at 400 tokens. A long report judged against the owner's real check list can't
 * answer inside that, so the JSON arrived cut off mid-array, JSON.parse threw, `catch { return null }`
 * ate it, and the caller had a second `.catch(() => null)` on top. The run finished with a clean ✓
 * and no verdict at all.
 *
 * Measured on three real runs: the 1,739-character BAD one was graded fail 0/100; the 12,174 and
 * 12,458-character GOOD ones got no grade. The better the report, the more certain the silence.
 */

describe('reading the grader’s reply (BEA-1247)', () => {
  const good = '{"verdict":"pass","score":90,"criteria":[{"text":"covered Pune","met":true}],"notes":"solid"}';

  it('reads a complete verdict', () => {
    const r = parseGrade(good);
    expect(r.ok).toBe(true);
    expect(r.grade!.verdict).toBe('pass');
    expect(r.grade!.score).toBe(90);
    expect(r.grade!.criteria).toHaveLength(1);
  });

  it('says the reply was CUT OFF when the JSON never closes', () => {
    // Exactly what a 400-token cap produced: truncated part-way through the criteria array.
    const cut = '{"verdict":"partial","score":60,"criteria":[{"text":"covered Pune","met":true},{"text":"covered Mum';
    const r = parseGrade(cut);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('the reply was cut off before it finished');
  });

  it('still says CUT OFF when a stray closing brace makes it look parseable', () => {
    // The greedy /\{[\s\S]*\}/ can match a broken fragment — braces must be counted, not trusted.
    const cut = '{"verdict":"fail","score":10,"criteria":[{"text":"one","met":false},{"text":"two"';
    const r = parseGrade(cut);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('the reply was cut off before it finished');
  });

  it('says the model returned NOTHING when it did', () => {
    expect(parseGrade('').reason).toBe('the grader returned nothing');
    expect(parseGrade(null).reason).toBe('the grader returned nothing');
    expect(parseGrade('   ').reason).toBe('the grader returned nothing');
  });

  it('says the format was wrong when there is no JSON at all', () => {
    const r = parseGrade('I am sorry, I cannot grade this.');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('the reply was not in the expected format');
  });

  it('says invalid JSON when it is complete but malformed', () => {
    const r = parseGrade('{"verdict":"pass" "score":90}');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('the reply was not valid JSON');
  });

  it('refuses a confident score that judged none of the owner’s checks', () => {
    const r = parseGrade('{"verdict":"pass","score":95,"criteria":[],"notes":"looks fine"}', 6);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('did not judge any of your checks');
  });

  it('keeps every one of the owner’s checks — it used to ask for 12 and keep 8', () => {
    const criteria = Array.from({ length: GRADE_MAX_CHECKS }, (_, i) => ({ text: `check ${i + 1}`, met: true }));
    const r = parseGrade(JSON.stringify({ verdict: 'pass', score: 100, criteria, notes: 'all met' }), GRADE_MAX_CHECKS);
    expect(r.ok).toBe(true);
    expect(r.grade!.criteria).toHaveLength(GRADE_MAX_CHECKS);
    expect(r.grade!.criteria[11].text).toBe('check 12');
  });

  it('the cap is big enough for a full check list — the whole bug was that it was not', () => {
    expect(GRADE_MAX_TOKENS).toBeGreaterThanOrEqual(1200);
  });
});

describe('the grader tells the run WHY it could not judge (BEA-1247)', () => {
  function bridge(reply: string | null, seen: { tokens?: number } = {}) {
    const agent: any = { outcomeFor: async () => ({ rubric: 'Cover every city', checks: ['Pune', 'Mumbai'] }) };
    const llm: any = { complete: async (_p: string, max: number) => { seen.tokens = max; return reply; } };
    return new HermesBridgeService(agent, {} as any, {} as any, {} as any, llm, {} as any);
  }

  it('asks for enough room to answer', async () => {
    const seen: { tokens?: number } = {};
    await bridge('{"verdict":"pass","score":80,"criteria":[{"text":"Pune","met":true}],"notes":"ok"}', seen).gradeFor('j1', 'a long report');
    // A real floor, not `toBe(GRADE_MAX_TOKENS)` — comparing against the constant would move with it
    // and pass even if someone put 400 back, which is the exact bug.
    expect(seen.tokens).toBeGreaterThanOrEqual(1200);
  });

  it('returns a REASON instead of null when the reply is cut off', async () => {
    const r = await bridge('{"verdict":"pass","score":80,"criteria":[{"text":"Pu').gradeFor('j1', 'a long report');
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    expect(r!.reason).toBe('the reply was cut off before it finished');
  });

  it('returns a REASON when the grader is unreachable, rather than swallowing the error', async () => {
    const agent: any = { outcomeFor: async () => ({ rubric: 'r', checks: [] }) };
    const llm: any = { complete: async () => { throw new Error('rate limited'); } };
    const b = new HermesBridgeService(agent, {} as any, {} as any, {} as any, llm, {} as any);
    const r = await b.gradeFor('j1', 'result');
    expect(r!.ok).toBe(false);
    expect(r!.reason).toContain('could not be reached');
    expect(r!.reason).toContain('rate limited');
  });

  it('an eval case that could not be graded says so, instead of posing as a "partial"', async () => {
    // The review caught this: there are TWO eval runners, and only the flow one had been fixed.
    // A run that finished fine but could not be graded landed on 'partial' with no notes — which
    // reads as a real judgement and is counted in the passed pill. The same silence, one screen over.
    const saved: any[] = [];
    const agent: any = {
      getAgent: async () => ({ id: 'j1', name: 'Job', rubric: 'r', evals: [{ id: 'e1', input: 'try this' }] }),
      setEvals: async (_id: string, evs: any[]) => { saved.push(JSON.parse(JSON.stringify(evs))); },
    };
    const b: any = new HermesBridgeService(agent, {} as any, {} as any, {} as any, {} as any, {} as any);
    b.runOneEval = async () => ({ runId: 'r1', status: 'done', grade: undefined, gradeError: 'the reply was cut off before it finished' });

    await b.runEvals('j1');

    const final = saved[saved.length - 1][0];
    expect(final.lastVerdict).toBe('ungraded');
    expect(final.lastVerdict).not.toBe('partial');
    expect(final.lastNotes).toContain('cut off');
    expect(final.lastGradeError).toBe('the reply was cut off before it finished');
  });

  it('a genuinely partial verdict is still partial — we only relabel the ones we could not judge', async () => {
    const saved: any[] = [];
    const agent: any = {
      getAgent: async () => ({ id: 'j1', name: 'Job', rubric: 'r', evals: [{ id: 'e1', input: 'try this' }] }),
      setEvals: async (_id: string, evs: any[]) => { saved.push(JSON.parse(JSON.stringify(evs))); },
    };
    const b: any = new HermesBridgeService(agent, {} as any, {} as any, {} as any, {} as any, {} as any);
    b.runOneEval = async () => ({ runId: 'r1', status: 'done', grade: { verdict: 'partial', score: 55, criteria: [], notes: 'half there' }, gradeError: null });

    await b.runEvals('j1');

    const final = saved[saved.length - 1][0];
    expect(final.lastVerdict).toBe('partial');
    expect(final.lastScore).toBe(55);
    expect(final.lastGradeError).toBeNull();
  });

  it('still returns null when there is genuinely nothing to grade against', async () => {
    const agent: any = { outcomeFor: async () => ({ rubric: '', checks: [] }) };
    const b = new HermesBridgeService(agent, {} as any, {} as any, {} as any, {} as any, {} as any);
    // No Outcome set is not a failure — the run stands, and nothing should be reported as broken.
    expect(await b.gradeFor('j1', 'result')).toBeNull();
    expect(await b.gradeFor('j1', '   ')).toBeNull();
  });
});
