/**
 * The builder CONVERSATIONS' shared bookkeeping (BEA-1370) — one place for the Setting keys the two
 * chat builders keep their state under, and for the sample-call caps that state now carries.
 *
 * Two builders, one shape: the top-level "New agent — just describe it" chat (`AgentAreasService.
 * builderChat`, key `agent.builder`) and the per-area job builder (`jobBuilderChat`, key
 * `agent.jobBuilder.<areaId>`). Each keeps `{ log, spec|job }` as JSON in a `Setting` row; the
 * sample counter (`samples`) lives in the SAME row so it survives a restart and is wiped by the same
 * reset the owner already has (`DELETE /api/agent/builder`, `DELETE …/job-builder`) — a fresh
 * conversation is a fresh budget, and nothing else needs to know.
 */

/** The `sessionKey` of the top-level builder. A job builder's session key is its area id. */
export const TOP_BUILDER_SESSION = 'new-agent';

/** The one place a builder session key becomes a Setting key. */
export function builderSettingKey(sessionKey: string): string {
  const k = String(sessionKey || '').trim();
  return k === TOP_BUILDER_SESSION ? 'agent.builder' : `agent.jobBuilder.${k}`;
}

/**
 * How much "looking for yourself" one conversation may do (design: `specs/THINKING-BUILDER.md` §B):
 * at most this many sample calls AND at most this many credits between them. Over either → the
 * builder is told to ask the owner instead. Constants here, tests in `builder-sample.spec.ts`.
 */
export const SAMPLE_CAPS = { calls: 3, credits: 5 } as const;

/** What the conversation remembers about its samples. Missing = nothing tried yet. */
export type SampleCounter = { used: number; credits: number };

export function readSampleCounter(v: any): SampleCounter {
  const used = Number(v?.samples?.used);
  const credits = Number(v?.samples?.credits);
  return { used: Number.isFinite(used) && used > 0 ? Math.floor(used) : 0, credits: Number.isFinite(credits) && credits > 0 ? credits : 0 };
}
