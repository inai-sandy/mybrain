// Approximate public list prices, USD per 1M tokens (input, output), 2026. Used to estimate cost from
// token counts when the provider doesn't return a dollar figure (Anthropic/Gemini/Codex). (BEA-716)
type Price = { in: number; out: number };

// First match wins — put the more specific patterns (mini/flash) BEFORE the broad ones.
const PRICES: { match: RegExp; price: Price }[] = [
  { match: /claude.*opus/i, price: { in: 15, out: 75 } },
  { match: /claude.*haiku/i, price: { in: 0.8, out: 4 } },
  { match: /claude.*sonnet/i, price: { in: 3, out: 15 } },
  { match: /gpt-4o-mini|gpt-4\.1-mini|gpt-5[.\-]?\w*mini|o4-mini|o3-mini/i, price: { in: 0.15, out: 0.6 } },
  { match: /o1|o3(?!-mini)/i, price: { in: 15, out: 60 } },
  { match: /gpt-5|gpt-4\.1|gpt-4o|codex/i, price: { in: 2.5, out: 10 } },
  { match: /gemini.*flash/i, price: { in: 0.15, out: 0.6 } },
  { match: /gemini.*pro/i, price: { in: 1.25, out: 5 } },
];
const FALLBACK: Price = { in: 1, out: 3 };

export function modelPrice(model: string): Price {
  const m = (model || '').toLowerCase();
  for (const p of PRICES) if (p.match.test(m)) return p.price;
  return FALLBACK;
}

/** Estimate USD cost for a request from its token counts + model. 0 when no tokens are known. */
export function estimateCost(model: string, promptTokens?: number | null, completionTokens?: number | null): number {
  const inT = promptTokens || 0;
  const outT = completionTokens || 0;
  if (!inT && !outT) return 0;
  const p = modelPrice(model);
  return (inT * p.in + outT * p.out) / 1_000_000;
}

/**
 * Features that run on the flat-rate Codex/ChatGPT subscription — their cost is "included", not billed.
 * Only the Codex run itself ('agent') — NOT the metered Anthropic helper calls 'agent-learn'/'agent-grade'.
 */
export function isIncludedFeature(feature: string): boolean {
  return feature === 'agent';
}
