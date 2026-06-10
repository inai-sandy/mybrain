import { UsageService } from './usage.service';

function make(keys: Record<string, any>) {
  const connectors: any = { get: async (n: string) => keys[n] ?? null };
  (global as any).fetch = jest.fn(async (url: string) => {
    if (url.includes('openrouter.ai/api/v1/auth/key'))
      return { ok: true, json: async () => ({ data: { usage: 5.33, usage_daily: 0.0048, usage_weekly: 0.48, usage_monthly: 5.33 } }) };
    if (url.includes('openrouter.ai/api/v1/credits'))
      return { ok: true, json: async () => ({ data: { total_credits: 210, total_usage: 179.19 } }) };
    if (url.includes('api.openai.com/v1/organization/costs')) {
      const now = Math.floor(Date.now() / 1000);
      return { ok: true, json: async () => ({ data: [
        { start_time: now - 3600, results: [{ amount: { value: 0.02 } }] },
        { start_time: now - 3 * 86400, results: [{ amount: { value: 0.10 } }] },
        { start_time: now - 20 * 86400, results: [{ amount: { value: 1.00 } }] },
      ] }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  return { svc: new UsageService(connectors) };
}

describe('UsageService', () => {
  it('maps OpenRouter key usage + account credits', async () => {
    const { svc } = make({ openrouter: { apiKey: 'k' } });
    const s = await svc.summary();
    expect(s.openrouter.week).toBe(0.48);
    expect(s.openrouter.total).toBe(5.33);
    expect(s.openrouter.credits.remaining).toBeCloseTo(30.81, 2);
    expect(s.openai.available).toBe(false); // no admin key
    expect(s.openai.reason).toBe('no-admin-key');
  });

  it('sums OpenAI cost buckets into today/week/month once an admin key exists', async () => {
    const { svc } = make({ openrouter: { apiKey: 'k' }, openai_admin: { apiKey: 'admin' } });
    const s = await svc.summary();
    expect(s.openai.available).toBe(true);
    expect(s.openai.today).toBeCloseTo(0.02, 4);
    expect(s.openai.week).toBeCloseTo(0.12, 4);
    expect(s.openai.month).toBeCloseTo(1.12, 4);
  });

  it('caches the summary so providers are not hammered', async () => {
    const { svc } = make({ openrouter: { apiKey: 'k' } });
    await svc.summary();
    const calls = (global.fetch as jest.Mock).mock.calls.length;
    await svc.summary();
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(calls); // no new calls
  });
});
