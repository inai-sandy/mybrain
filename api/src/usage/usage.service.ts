import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { PrismaService } from '../prisma/prisma.service';
import { estimateCost, isIncludedFeature } from './pricing';

const CACHE_MS = 5 * 60 * 1000; // OpenRouter/OpenAI usage doesn't move fast — don't hammer them

/** Live AI spend: OpenRouter (this app's key + account credits) and OpenAI (needs an Admin key). */
@Injectable()
export class UsageService {
  constructor(
    private readonly connectors: ConnectorService,
    private readonly prisma: PrismaService,
  ) {}
  private cache: { at: number; data: any } | null = null;

  /** Build an `at` filter from a YYYY-MM-DD date range (inclusive). The dates are the user's LOCAL
   *  (IST) days, so anchor the boundaries to +05:30 — using UTC midnights attributed spend made
   *  00:00–05:30 IST to the wrong day and gave wrong totals at the edges. (BEA-806) */
  private dateFilter(from?: string, to?: string): any {
    const at: any = {};
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) at.gte = new Date(from + 'T00:00:00.000+05:30');
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) at.lte = new Date(to + 'T23:59:59.999+05:30');
    return Object.keys(at).length ? at : null;
  }

  /** Per-feature cost totals from the app's own request log — over a date range, else the last `days`. */
  async features(days = 7, from?: string, to?: string) {
    const dr = this.dateFilter(from, to);
    const at = dr || { gte: new Date(Date.now() - Math.max(1, Math.min(366, days)) * 86400_000) };
    const rows = await this.prisma.usageLog.findMany({ where: { at }, select: { feature: true, cost: true, model: true, promptTokens: true, completionTokens: true } });
    const map: Record<string, { cost: number; requests: number; tokens: number; included: boolean }> = {};
    for (const r of rows) {
      // Use the provider's $ where it gave one, else estimate from the tokens we logged (BEA-716).
      const cost = r.cost ?? estimateCost(r.model, r.promptTokens, r.completionTokens);
      map[r.feature] = map[r.feature] || { cost: 0, requests: 0, tokens: 0, included: isIncludedFeature(r.feature) };
      map[r.feature].requests++;
      map[r.feature].cost += cost;
      // Tokens the owner asked to SEE (BEA-1245) — in + out, real counts where the provider gave them.
      map[r.feature].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
    }
    const features = Object.entries(map)
      .map(([feature, v]) => ({ feature, cost: v.cost, requests: v.requests, tokens: v.tokens, included: v.included }))
      .sort((a, b) => b.cost - a.cost);
    // Flat-rate Codex features ('included') are shown separately and kept OUT of the real spend total.
    const totalCost = features.filter((f) => !f.included).reduce((s, f) => s + f.cost, 0);
    const includedEstimate = features.filter((f) => f.included).reduce((s, f) => s + f.cost, 0);
    const includedRequests = features.filter((f) => f.included).reduce((s, f) => s + f.requests, 0);
    const paidTokens = features.filter((f) => !f.included).reduce((s, f) => s + f.tokens, 0);
    const includedTokens = features.filter((f) => f.included).reduce((s, f) => s + f.tokens, 0);
    return { days, from, to, features, totalCost, includedEstimate, includedRequests, paidTokens, includedTokens, totalRequests: rows.length };
  }

  /**
   * Tokens per agent and per job, rolled up from flow runs (BEA-1245).
   *
   * Every deep run and every voice job executes as a FLOW, and each flow run stores what it spent
   * (`FlowRun.spend.tokens`, plus searches/reads). Quick agent chats log tokens in the usage log but
   * carry no agent link, so this rollup is honest about its source: it counts the flow runs — which
   * is where virtually all the money and minutes go.
   */
  async agents(days = 30) {
    const since = new Date(Date.now() - Math.max(1, Math.min(366, days)) * 86400_000);
    // These queries are NOT wrapped in catch-to-empty: a broken query must 500, because an empty
    // rollup reads as "nothing was spent" — the wrong message at the worst time (review, BEA-1245).
    const jobs: any[] = await (this.prisma as any).agent.findMany({ select: { id: true, name: true, areaId: true } });
    const areas: any[] = await (this.prisma as any).agentArea.findMany({ select: { id: true, name: true, icon: true } });
    const flows: any[] = await (this.prisma as any).flow.findMany({ where: { agentId: { not: null } }, select: { id: true, agentId: true } });
    const flowIds = flows.map((f) => f.id);
    const runs: any[] = flowIds.length
      ? await (this.prisma as any).flowRun.findMany({ where: { flowId: { in: flowIds }, startedAt: { gte: since } }, select: { flowId: true, spend: true, status: true } }).catch(() => [])
      : [];
    const jobByFlow = new Map(flows.map((f) => [f.id, f.agentId]));
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const areaById = new Map(areas.map((a) => [a.id, a]));
    const perJob: Record<string, { jobId: string; job: string; areaId: string | null; agent: string; runs: number; tokens: number; searches: number; reads: number }> = {};
    for (const r of runs) {
      const jobId = jobByFlow.get(r.flowId);
      if (!jobId) continue;
      const j: any = jobById.get(jobId) || { name: '(deleted job)', areaId: null };
      const a: any = j.areaId ? areaById.get(j.areaId) : null;
      const row = (perJob[jobId] = perJob[jobId] || { jobId, job: j.name, areaId: j.areaId || null, agent: a?.name || '(no agent)', runs: 0, tokens: 0, searches: 0, reads: 0 });
      row.runs++;
      let sp: any = null;
      try { sp = r.spend ? JSON.parse(r.spend) : null; } catch { sp = null; }
      row.tokens += Number(sp?.tokens) || 0;
      row.searches += Number(sp?.searches) || 0;
      row.reads += Number(sp?.extracts) || 0;
    }
    const jobsOut = Object.values(perJob).sort((x, y) => y.tokens - x.tokens);
    const perAgent: Record<string, { areaId: string; agent: string; icon?: string; runs: number; tokens: number; searches: number; reads: number }> = {};
    for (const j of jobsOut) {
      const key = j.areaId || 'none';
      const a: any = j.areaId ? areaById.get(j.areaId) : null;
      const row = (perAgent[key] = perAgent[key] || { areaId: key, agent: a?.name || '(no agent)', icon: a?.icon, runs: 0, tokens: 0, searches: 0, reads: 0 });
      row.runs += j.runs; row.tokens += j.tokens; row.searches += j.searches; row.reads += j.reads;
    }
    const agents = Object.values(perAgent).sort((x, y) => y.tokens - x.tokens);
    const total = { runs: jobsOut.reduce((s2, j) => s2 + j.runs, 0), tokens: jobsOut.reduce((s2, j) => s2 + j.tokens, 0), searches: jobsOut.reduce((s2, j) => s2 + j.searches, 0), reads: jobsOut.reduce((s2, j) => s2 + j.reads, 0) };
    return { days, total, agents, jobs: jobsOut };
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
