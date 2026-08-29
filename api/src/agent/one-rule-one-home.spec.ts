import * as fs from 'fs';
import * as path from 'path';
import { CHOOSE_TOOLS_RULE } from './prompt-rules';
import { SANDBOX_RULE, TRIAL_RULE } from '../worker/brief-rules';

/**
 * A rule lives in ONE place (BEA-1544).
 *
 * His words, after the same question was asked of him twice in one morning by two different prompts:
 * *"Fixing every file the way you want to do, but it's creating more and more and more problems."*
 *
 * He was right, and this is the mechanism. `CLAUDE.md` has said it since BEA-1462 — *"A rule with two
 * call sites should be a function with one. This has now cost FOUR real runs."* — but that lesson was
 * only ever applied to CODE. Prompts are prose, no compiler reads them, and nothing noticed that the
 * tool rule had been written out longhand in two prompts until he was asked twice.
 *
 * Code rules are in good shape: every decision that has bitten before — `whyNotBuildable`,
 * `buildHashFor`, `isDirectFetchAgent`, `isRiskyAction` — is defined once and called from many
 * places. This test extends the same standard to the rules written in English.
 */

const SRC = path.join(__dirname, '..');

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.includes('.spec.')) out.push(p);
    }
  };
  walk(SRC);
  return out;
}

/** The sentence, as a prompt would carry it — whitespace and line breaks flattened. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function filesContaining(sentence: string): string[] {
  const needle = flat(sentence);
  return sourceFiles().filter((f) => flat(fs.readFileSync(f, 'utf8')).includes(needle));
}

describe('a shared prompt rule is written once', () => {
  // The rule he was asked about twice. If a third prompt ever writes it out longhand instead of
  // importing it, this fails — which is the whole point.
  it('the tool-choice rule exists in exactly one file', () => {
    const files = filesContaining(CHOOSE_TOOLS_RULE);
    expect(files.map((f) => path.basename(f))).toEqual(['prompt-rules.ts']);
  });

  it('the Codex sandbox rule exists in exactly one file', () => {
    const files = filesContaining(SANDBOX_RULE);
    expect(files.map((f) => path.basename(f))).toEqual(['brief-rules.ts']);
  });

  // The check's contract (BEA-1578). A build that meets the trial blind gropes toward how the check
  // behaves — one worker asked for a held sheet's link 1,610 times. The rule that ends that must
  // never fork into two wordings.
  it('the trial rule exists in exactly one file', () => {
    const files = filesContaining(TRIAL_RULE);
    expect(files.map((f) => path.basename(f))).toEqual(['brief-rules.ts']);
  });

  // Both prompts must actually USE it — a shared constant nobody imports is worse than a copy, because
  // it looks deduplicated and isn't.
  it('both prompts that need the tool rule import it', () => {
    for (const f of ['agent/thinking-builder.ts', 'agent/goal.ts']) {
      const s = fs.readFileSync(path.join(SRC, f), 'utf8');
      expect(s).toContain('CHOOSE_TOOLS_RULE');
    }
  });

  it('both briefs that need the sandbox rule import it', () => {
    for (const f of ['worker/build-brief.ts', 'worker/repair.ts']) {
      const s = fs.readFileSync(path.join(SRC, f), 'utf8');
      expect(s).toContain('SANDBOX_RULE');
    }
  });

  it('both briefs that need the trial rule import it', () => {
    for (const f of ['worker/build-brief.ts', 'worker/repair.ts']) {
      const s = fs.readFileSync(path.join(SRC, f), 'utf8');
      expect(s).toContain('TRIAL_RULE');
    }
  });
});

describe('no prompt tells the model to ask him which tool', () => {
  // The exact failure, in his words: "Which connected tools should the agent use to create and
  // populate the Google Sheet and send the WhatsApp message?" He does not know the action ids.
  it('nothing instructs it to ask him to pick a tool', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const s = flat(fs.readFileSync(f, 'utf8'));
      // The instruction shape, not the words explaining why we removed it.
      if (/ask him which (tool|service|action)/.test(s) && !/never ask|not "ask him which"|do not ask/.test(s)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders).toEqual([]);
  });
});
