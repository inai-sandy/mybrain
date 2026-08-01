/**
 * Reading the grader's reply — and saying plainly when it can't be read (BEA-1247).
 *
 * Both grading paths (an agent run in hermes-bridge, an eval run in flows-runner) used to do this
 * inline, cap the reply at 400 tokens, and swallow every failure into `null`. A long report judged
 * against a real check list cannot answer inside 400 tokens, so the JSON arrived cut off mid-array,
 * JSON.parse threw, and the run reported ✓ done with no verdict and no explanation.
 *
 * One parser, one cap, and a REASON on every failure.
 */

export type Grade = {
  verdict: 'pass' | 'partial' | 'fail';
  score: number;
  criteria: Array<{ text: string; met: boolean }>;
  notes: string;
};

/**
 * Deliberately NOT a discriminated union. This project compiles with `strict: false`, and without
 * strictNullChecks TypeScript will not narrow `{ok:true}|{ok:false}` — every `gr.reason` after an
 * `if (gr.ok)` fails to compile. Optional fields say the same thing and work here.
 *
 * `ok` is the only field to branch on: when it is true `grade` is set, otherwise `reason` is.
 */
export type GradeResult = { ok: boolean; grade?: Grade; reason?: string };

/**
 * Room for a real verdict. Twelve criteria at ~55 tokens each is ~660, plus verdict, score and
 * notes. The old 400 could not hold half of that, which is the whole bug.
 */
export const GRADE_MAX_TOKENS = 1500;

/** How many of the owner's checks are judged. Kept the SAME everywhere — the prompt used to ask for
 *  12 and the reader then kept only the first 8, quietly dropping four of the owner's own checks. */
export const GRADE_MAX_CHECKS = 12;

/**
 * Turn the grader's raw reply into a verdict, or into the reason it could not be read.
 *
 * The reasons are deliberately distinguishable, because they need different fixes: a cut-off reply
 * means the cap is too small for this job, a missing reply means the model was unavailable, and
 * malformed JSON means the prompt is being ignored.
 */
export function parseGrade(out: string | null | undefined, expectedChecks = 0): GradeResult {
  const raw = (out || '').trim();
  if (!raw) return { ok: false, reason: 'the grader returned nothing' };

  const opens = (raw.match(/\{/g) || []).length;
  const closes = (raw.match(/\}/g) || []).length;
  const truncated = opens > closes;

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    return opens
      ? { ok: false, reason: 'the reply was cut off before it finished' }
      : { ok: false, reason: 'the reply was not in the expected format' };
  }

  let g: any;
  try {
    g = JSON.parse(m[0]);
  } catch {
    return truncated
      ? { ok: false, reason: 'the reply was cut off before it finished' }
      : { ok: false, reason: 'the reply was not valid JSON' };
  }

  const verdict: Grade['verdict'] = ['pass', 'partial', 'fail'].includes(g?.verdict) ? g.verdict : 'partial';
  const score = Math.max(0, Math.min(100, Math.round(Number(g?.score) || 0)));
  const criteria = Array.isArray(g?.criteria)
    ? g.criteria.slice(0, GRADE_MAX_CHECKS).map((c: any) => ({ text: String(c?.text || '').slice(0, 160), met: !!c?.met }))
    : [];
  // A verdict with no criteria at all, when checks WERE given, is not a real judgement — it is the
  // model shrugging. Say so rather than showing a confident score nobody can check.
  if (expectedChecks > 0 && !criteria.length) {
    return { ok: false, reason: 'the grader gave a score but did not judge any of your checks' };
  }
  return { ok: true, grade: { verdict, score, criteria, notes: String(g?.notes || '').slice(0, 240) } };
}
