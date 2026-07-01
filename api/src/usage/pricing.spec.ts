import { estimateCost, modelPrice, isIncludedFeature } from './pricing';

describe('usage pricing (BEA-716)', () => {
  it('estimates Claude Sonnet cost from tokens (in + out)', () => {
    expect(estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(3 + 15, 5);
  });
  it('Haiku is cheaper than Sonnet', () => {
    expect(estimateCost('claude-haiku-4-5', 1e6, 0)).toBeLessThan(estimateCost('claude-sonnet-4-6', 1e6, 0));
  });
  it('matches mini models before the broad gpt pattern', () => {
    expect(modelPrice('gpt-4o-mini').in).toBe(0.15);
    expect(modelPrice('gpt-4o').in).toBe(2.5);
  });
  it('unknown model uses the fallback, not zero', () => {
    expect(estimateCost('totally-unknown-model', 1e6, 0)).toBe(1);
  });
  it('no tokens → 0 (nothing to estimate)', () => {
    expect(estimateCost('claude-sonnet-4-6', 0, 0)).toBe(0);
    expect(estimateCost('claude-sonnet-4-6', null, null)).toBe(0);
  });
  it('only the Codex run feature "agent" is flat-rate included; metered helper calls are not', () => {
    expect(isIncludedFeature('agent')).toBe(true);
    expect(isIncludedFeature('agent-learn')).toBe(false); // Anthropic-metered helper, real cost
    expect(isIncludedFeature('agent-grade')).toBe(false);
    expect(isIncludedFeature('story-of-day')).toBe(false);
    expect(isIncludedFeature('chat')).toBe(false);
  });
});
