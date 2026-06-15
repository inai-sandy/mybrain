import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { PrismaService } from '../prisma/prisma.service';

const CACHE_MS = 5 * 60 * 1000; // OpenRouter/OpenAI usage doesn't move fast — don't hammer them

/** Live AI spend: OpenRouter (this app's key + account credits) and OpenAI (needs an Admin key). */
@Injectable()
export class UsageService {
  constructor(
    private readonly connectors: ConnectorService,
    private readonly prisma: PrismaService,
  ) {}
  private cache: { at: number; data: any } | null = null;

  /** Build an `at` filter from a YYYY-MM-DD date range (inclusive). */
  private dateFilter(from?: string, to?: string): any {
    const at: any = {};
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) at.gte = new Date(from + 'T00:00:00.000Z');
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) at.lte = new Date(to + 'T23:59:59.999Z');
    return Object.keys(at).length ? at : null;
  }

  /** Per-feature cost totals from the app's own request log — over a date range, else the last `days`. */
  async features(days = 7, from?: string, to?: string) {
    const dr = this.dateFilter(from, to);
    const at = dr || { gte: new Date(Date.now() - Math.max(1, Math.min(366, days)) * 86400_000) };
    const rows = await this.prisma.usageLog.findMany({ where: { at }, select: { feature: true, cost: true } });
    const map: Record<string, { cost: number; requests: number }> = {};
    for (const r of rows) {
      map[r.feature] = map[r.feature] || { cost: 0, requests: 0 };
      map[r.feature].requests++;
      map[r.feature].cost += r.cost || 0;
    }
    const features = Object.entries(map)
      .map(([feature, v]) => ({ feature, cost: v.cost, requests: v.requests }))
      .sort((a, b) => b.requests - a.requests);
    return { days, from, to, features, totalCost: features.reduce((s, f) => s + f.cost, 0), totalRequests: rows.length };
  }

  /** Individual requests (newest first), optionally filtered by feature and date range. */
  async requests(limit = 25, offset = 0, feature?: string, from?: string, to?: string) {
    const dr = this.dateFilter(from, to);
    const where: any = { ...(feature ? { feature } : {}), ...(dr ? { at: dr } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.usageLog.findMany({ where, orderBy: { at: 'desc' }, take: Math.max(1, Math.min(100, limit)), skip: Math.max(0, offset) }),
      this.prisma.usageLog.count({ where }),
    ]);
    return { total, requests: rows };
  }

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
