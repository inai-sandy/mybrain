import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';

const CACHE_MS = 5 * 60 * 1000; // OpenRouter/OpenAI usage doesn't move fast — don't hammer them

/** Live AI spend: OpenRouter (this app's key + account credits) and OpenAI (needs an Admin key). */
@Injectable()
export class UsageService {
  constructor(private readonly connectors: ConnectorService) {}
  private cache: { at: number; data: any } | null = null;

  async summary() {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.data;

    const [openrouter, openai] = await Promise.all([this.openrouter(), this.openai()]);
    const data = { openrouter, openai, fetchedAt: new Date().toISOString() };
    this.cache = { at: Date.now(), data };
    return data;
  }

  private async openrouter() {
    const c = await this.connectors.get<{ apiKey: string }>('openrouter').catch(() => null);
    if (!c?.apiKey) return null;
    try {
      const h = { Authorization: `Bearer ${c.apiKey}` };
      const [kr, cr] = await Promise.all([
        fetch('https://openrouter.ai/api/v1/auth/key', { headers: h }),
        fetch('https://openrouter.ai/api/v1/credits', { headers: h }),
      ]);
      if (!kr.ok) return null;
      const k: any = (await kr.json())?.data || {};
      const cd: any = cr.ok ? (await cr.json())?.data || {} : {};
      const total = Number(cd.total_credits ?? 0);
      const used = Number(cd.total_usage ?? 0);
      return {
        today: Number(k.usage_daily ?? 0),
        week: Number(k.usage_weekly ?? 0),
        month: Number(k.usage_monthly ?? 0),
        total: Number(k.usage ?? 0),
        credits: cr.ok ? { total, used, remaining: Math.max(0, total - used) } : null,
      };
    } catch {
      return null;
    }
  }

  /** OpenAI org costs — only works with an Admin key (api.usage.read); the normal key 403s. */
  private async openai() {
    const c = await this.connectors.get<{ apiKey: string }>('openai_admin').catch(() => null);
    if (!c?.apiKey) return { available: false, reason: 'no-admin-key' };
    try {
      const now = Math.floor(Date.now() / 1000);
      const start = now - 30 * 86400;
      const r = await fetch(`https://api.openai.com/v1/organization/costs?start_time=${start}&bucket_width=1d&limit=31`, {
        headers: { Authorization: `Bearer ${c.apiKey}` },
      });
      if (!r.ok) return { available: false, reason: `http-${r.status}` };
      const d: any = await r.json();
      const buckets: { start_time: number; amount: number }[] = (d?.data || []).map((b: any) => ({
        start_time: b.start_time,
        amount: (b.results || []).reduce((s: number, x: any) => s + Number(x?.amount?.value ?? 0), 0),
      }));
      const sum = (since: number) => buckets.filter((b) => b.start_time >= since).reduce((s, b) => s + b.amount, 0);
      return {
        available: true,
        today: sum(now - 86400),
        week: sum(now - 7 * 86400),
        month: sum(start),
      };
    } catch {
      return { available: false, reason: 'error' };
    }
  }
}
