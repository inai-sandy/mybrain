/**
 * The curated, known-good OpenRouter model ids the small pickers offer (EMO brain/talk/router,
 * dictation cleanup). ONE list — the web builds its selects from what the server answers, and
 * anything offered here MUST save (BEA-1233).
 *
 * `openai/gpt-5.6-terra` joined on the owner's word (BEA-1624, 2026-09-05: "why are we using
 * Claude Haiku?" → "use gpt-5.6-terra"; verified on OpenRouter: 1,050,000 ctx, $2/M in, $12/M out).
 */
export const TERRA_MODEL = 'openai/gpt-5.6-terra';

export const CURATED_MODELS: readonly string[] = [
  'anthropic/claude-sonnet-5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-haiku-4.5',
  TERRA_MODEL,
  'openai/gpt-5',
  'openai/gpt-4o',
];

export const isCuratedModel = (id: string): boolean => CURATED_MODELS.includes(id);
