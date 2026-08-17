import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { LlmService } from './llm.service';

/**
 * BEA-1248 — agent and flow thinking must never run on the app's loose general model.
 *
 * `llm.complete()` resolves to `getConfig()` — the general `llm` setting. Its `label` argument is
 * only a tag for the usage log; it selects nothing. So every call that reached `complete()` directly
 * ran on whatever that setting happened to be. It was `qwen/qwen3.7-max` on the morning of 1 Aug
 * (the model that returned nothing twice and killed two branches of a real run) and
 * `moonshotai/kimi-k3` by the afternoon. Freezing the engine to Codex covered none of them.
 *
 * The grader was the worst case: the thing that tells the owner whether a run was any good was
 * itself running on an unnamed moving target, and had no entry in HELPERS at all — so it could not
 * be pointed anywhere from Settings even once you knew.
 */

const SRC = join(__dirname, '..');

/**
 * Every source file in the agent, flow and bridge folders — scanned, not listed. A hardcoded list
 * would leave a NEW service in these folders silently unchecked, which is how this class of bug
 * spreads in the first place.
 */
function inScope(): string[] {
  const out: string[] = [];
  // `social` joined in BEA-1357: a Social agent's run is agent work too (its shaping step).
  for (const dir of ['flows', 'agent', 'hermes', 'social']) {
    for (const f of readdirSync(join(SRC, dir))) {
      const rel = `${dir}/${f}`;
      if (f.endsWith('.ts') && !f.endsWith('.spec.ts') && statSync(join(SRC, rel)).isFile()) out.push(rel);
    }
  }
  return out;
}
const IN_SCOPE = inScope();

describe('no agent or flow call reaches the general model (BEA-1248)', () => {
  it.each(IN_SCOPE)('%s only calls complete() as a stub fallback beside a named helper', (rel) => {
    const lines = readFileSync(join(SRC, rel), 'utf8').split('\n');
    const offenders = lines
      .map((line, i) => ({ line: line.trim(), i }))
      .filter((l) => /this\.llm\.complete\(/.test(l.line))
      // The codebase idiom is `completeHelper ? completeHelper('key', …) : complete(…)`, often split
      // over three lines. The bare arm exists only for spec harnesses that stub a partial llm.
      //
      // Proximity alone is not enough — a stray comment mentioning completeHelper() a line above
      // would excuse a genuine bare call. So both arms must name the SAME job: the usage-log label
      // on the bare arm must match the one the helper arm passes. (The helper KEY often differs from
      // the label by design — 'sync-words' logs as 'flow-sync-words' — so the labels are what tie
      // the two arms together.) A lone bare call has no matching helper call above it.
      .filter((l) => {
        const window = lines.slice(Math.max(0, l.i - 3), l.i + 1).join(' ');
        const helperLabel = window.match(/completeHelper\(\s*'[a-z0-9-]+'[^)]*?'([a-z0-9-]+)'\s*\)/)?.[1];
        const bareLabel = l.line.match(/,\s*'([a-z0-9-]+)'\s*\)/)?.[1];
        return !helperLabel || !bareLabel || helperLabel !== bareLabel;
      });
    expect(offenders.map((o) => `${rel}:${o.i + 1} ${o.line.slice(0, 90)}`)).toEqual([]);
  });

  it('every helper key used in the agent and flow path is registered, so Settings can change it', () => {
    const keys = new Set<string>();
    for (const rel of IN_SCOPE) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      for (const m of src.matchAll(/completeHelper\(\s*'([a-z0-9-]+)'/g)) keys.add(m[1]);
    }
    expect(keys.size).toBeGreaterThan(0);
    const unregistered = [...keys].filter((k) => !(k in LlmService.HELPERS));
    expect(unregistered).toEqual([]);
  });

  it('grading in particular has a deliberate model — it used to have no entry at all', () => {
    expect(LlmService.HELPERS['agent-grade']).toBeTruthy();
    expect(LlmService.HELPERS['flow-eval-grade']).toBeTruthy();
    // Both graders must agree. A run judged one way on the agent page and another on the Checks
    // panel is worse than no verdict.
    expect(LlmService.HELPERS['flow-eval-grade']).toEqual(LlmService.HELPERS['agent-grade']);
  });

  it('splitting a question does NOT pay the engine tax — it is a short text job', () => {
    // decompose gets only the raw question and returns 2-5 short strings; an engine turn drags
    // ~25,000 tokens of system prompt for a ~400-token job. Same reasoning as deep-research-plan.
    expect(LlmService.HELPERS['flow-decompose']).toEqual(LlmService.HELPERS['deep-research-plan']);
    expect(LlmService.HELPERS['flow-decompose']).not.toEqual(LlmService.FOLLOW_ENGINE);
    // The full split reasons over the whole tool catalog, so it gets a strong API model — pinned
    // Sonnet 5 since BEA-1244, never the engine (the split must not wait behind engine quota).
    expect(LlmService.HELPERS['flow-plan']).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' });
  });

  it('every new helper key has a control in Settings, or the owner still cannot change it', () => {
    // The point of registering a key is that the owner can point it somewhere. A key with no card
    // is only half a fix — this issue exists because grading had no card at all.
    const settings = readFileSync(join(SRC, '../../web/src/pages/Settings.tsx'), 'utf8');
    const missing = ['agent-grade', 'flow-eval-grade', 'flow-decompose', 'suggest-evals', 'agent-learn', 'news-categorise', 'social-shape']
      .filter((k) => !settings.includes(`/api/llm-config/helper/${k}`));
    expect(missing).toEqual([]);
  });
});

describe('a helper with a chosen model never silently uses another one (BEA-1248)', () => {
  function svc(helperCfg: any, helperText: string | null, defaultText = 'FROM THE GENERAL MODEL') {
    const s: any = new LlmService({} as any, {} as any, {} as any);
    s.helperModel = async () => helperCfg;
    s.completeWithModel = async () => ({ text: helperText });
    s.complete = async () => defaultText;
    return s as LlmService;
  }

  it('returns nothing rather than falling through to the general model', async () => {
    // This is the whole bug: completeHelper used to end `return this.complete(...)`, so a helper
    // whose model came back empty quietly finished on the app's general setting.
    const out = await svc({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }, null).completeHelper('agent-grade', 'p');
    expect(out).toBeNull();
  });

  it('uses the helper model when it answers', async () => {
    const out = await svc({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }, 'a real verdict').completeHelper('agent-grade', 'p');
    expect(out).toBe('a real verdict');
  });

  it('still uses the app default when a helper genuinely has no model of its own', async () => {
    // "No opinion" is different from "my model failed" — only the first should use the default.
    const out = await svc(null, null).completeHelper('something-unregistered', 'p');
    expect(out).toBe('FROM THE GENERAL MODEL');
  });
});
