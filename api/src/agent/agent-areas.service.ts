import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from './agent.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';

// `id` is the catalog id (BEA-1167) — present when the tool was picked from the one catalog, absent
// on the older hand-typed entries. It is what makes a toolbox mean something at run time.
export type AreaTool = { id?: string; kind: 'skill' | 'api' | 'mcp' | 'cli'; name: string; note?: string; status?: 'installed' | 'needed' };

/**
 * Agent AREAS (BEA-1095) — the container the owner thinks of as "an agent" (Research Agent,
 * Daily News). An area holds a visible Tools list and many jobs (Agent rows). Jobs keep living in
 * the Agent table so every run/flow/waitpoint reference keeps working untouched.
 */
@Injectable()
export class AgentAreasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentSvc?: AgentService, // optional + LAST — spec files construct positionally
    private readonly llm?: LlmService,
    private readonly promptsSvc?: PromptsService,
  ) {}

  /**
   * The one permanent Research Agent (BEA-1110) — the collector for one-time research jobs from
   * bookmarks, voice, anywhere. Found by name (never duplicated), created on first need.
   */
  async ensureResearchAgent(): Promise<{ id: string }> {
    const rows = await (this.prisma as any).agentArea.findMany({ select: { id: true, name: true } });
    const hit = rows.find((r: any) => String(r.name).trim().toLowerCase() === 'research agent');
    if (hit) return { id: hit.id };
    const area = await this.create({
      name: 'Research Agent', icon: '🔬', color: '#22d3ee',
      description: 'Deep-dives you ask for — from bookmarks, voice, anywhere. One report per job.',
    });
    return { id: area.id };
  }

  // ---- The in-app chat builder (BEA-1104): a persisted conversation that designs a new agent. ----

  private async builderLoad(): Promise<{ log: any[]; spec: any | null }> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'agent.builder' } }).catch(() => null);
    try { return row ? JSON.parse((row as any).value) : { log: [], spec: null }; } catch { return { log: [], spec: null }; }
  }
  private async builderSave(st: { log: any[]; spec: any | null }) {
    const value = JSON.stringify({ log: st.log.slice(-40), spec: st.spec });
    await this.prisma.setting.upsert({ where: { key: 'agent.builder' }, create: { key: 'agent.builder', value }, update: { value } });
  }

  async builderState() { return this.builderLoad(); }
  async builderReset() { await this.builderSave({ log: [], spec: null }); return { ok: true }; }

  /** One builder turn: owner's message → the designer's reply (+ the evolving spec). Flat-rate
   *  Codex first (the llm layer falls back to Sonnet automatically), so API calls stay minimal. */
  async builderChat(message: string): Promise<{ reply: string; spec: any | null }> {
    const msg = (message || '').trim().slice(0, 1000);
    if (!msg) throw new BadRequestException('Say something first.');
    const st = await this.builderLoad();
    const at = new Date().toISOString();
    st.log.push({ who: 'you', text: msg, at });
    const cantDo = "I couldn't work that out — try saying it another way.";
    try {
      const tpl = (await this.promptsSvc?.get('agent.builder').catch(() => '')) || '';
      const convo = st.log.slice(-20).map((m: any) => `${m.who === 'you' ? 'OWNER' : 'YOU'}: ${m.text}`).join('\n');
      const specNote = st.spec ? `\n\nThe spec you last proposed (refine it, don't start over):\n${JSON.stringify(st.spec)}` : '';
      const { text } = (await this.llm?.completeWithModel({ provider: 'codex', model: 'codex' }, tpl.replaceAll('{{conversation}}', convo) + specNote, 1600, 'agent-builder')) || { text: null };
      const m = (text || '').match(/\{[\s\S]*\}/);
      const g = m ? JSON.parse(m[0]) : null;
      const reply = String(g?.reply || cantDo).slice(0, 800);
      if (g?.spec && typeof g.spec === 'object' && g.spec.area?.name) st.spec = g.spec;
      st.log.push({ who: 'ai', text: reply, at: new Date().toISOString() });
      await this.builderSave(st);
      return { reply, spec: st.spec };
    } catch {
      st.log.push({ who: 'ai', text: cantDo, at: new Date().toISOString() });
      await this.builderSave(st);
      return { reply: cantDo, spec: st.spec };
    }
  }

  /** Create the agent from the current proposal (the owner pressed Create). */
  async builderCreate() {
    const st = await this.builderLoad();
    if (!st.spec) throw new BadRequestException('There is no proposal to create yet — keep chatting.');
    const res = await this.createFromSpec(st.spec);
    st.log.push({ who: 'ai', text: `Created ✓ — "${st.spec.area.name}" with ${res.jobs.length} job(s).`, at: new Date().toISOString() });
    st.spec = null;
    await this.builderSave(st);
    return res;
  }

  /**
   * Create a WHOLE agent from a spec in one call (BEA-1103) — the landing point for the Claude
   * Code skill and the in-app chat builder: area (identity + tools) + its jobs (each with task,
   * outcome, schedule and per-job settings). Nothing partial: a bad spec is refused up front.
   */
  async createFromSpec(spec: any): Promise<{ ok: true; areaId: string; url: string; jobs: { id: string; name: string }[] }> {
    const areaIn = spec?.area || {};
    const jobsIn: any[] = Array.isArray(spec?.jobs) ? spec.jobs : [];
    if (!areaIn?.name?.trim()) throw new BadRequestException('The agent needs a name.');
    if (!jobsIn.length) throw new BadRequestException('Give the agent at least one job.');
    for (const j of jobsIn) {
      if (!j?.name?.trim() || !j?.task?.trim()) throw new BadRequestException(`Every job needs a name and a task (check "${j?.name || '?'}").`);
    }
    if (!this.agentSvc) throw new BadRequestException('Agent service unavailable.');
    const area = await this.create({
      name: areaIn.name, icon: areaIn.icon, color: areaIn.color, description: areaIn.description,
      tools: areaIn.tools, sourceUrl: areaIn.sourceUrl,
    });
    const jobs: { id: string; name: string }[] = [];
    for (const j of jobsIn.slice(0, 12)) {
      const created: any = await this.agentSvc.createAgent({
        areaId: area.id,
        name: j.name.trim(),
        icon: j.icon || areaIn.icon || undefined,
        color: j.color || areaIn.color || undefined,
        description: j.description || undefined,
        prompt: String(j.task).trim(),
        rubric: j.outcome ? String(Array.isArray(j.outcome) ? j.outcome.map((o: any) => `- ${o}`).join('\n') : j.outcome).slice(0, 2000) : undefined,
        autonomy: ['cautious', 'balanced', 'autopilot'].includes(j.autonomy) ? j.autonomy : 'cautious',
        defaultDepth: j.depth,
        schedule: j.schedule && typeof j.schedule === 'object' ? j.schedule : undefined,
        scheduleText: j.scheduleText || undefined,
        evals: Array.isArray(j.evals) ? j.evals.slice(0, 5).map((input: any) => ({ id: 'ev_' + Math.random().toString(36).slice(2, 9), input: String(input).slice(0, 300) })) : undefined,
      } as any);
      const settings: any = {};
      if (j.notifyWhatsApp != null) settings.notifyWhatsApp = !!j.notifyWhatsApp;
      if (j.keepDays !== undefined) settings.keepDays = j.keepDays;
      if (Object.keys(settings).length) await this.agentSvc.updateAgent(created.id, settings).catch(() => undefined);
      jobs.push({ id: created.id, name: created.name });
    }
    return { ok: true, areaId: area.id, url: `/agent/ar/${area.id}`, jobs };
  }

  private parse<T>(s: string | null | undefined, fb: T): T {
    try { return s ? (JSON.parse(s) as T) : fb; } catch { return fb; }
  }

  private shape(area: any, jobs: any[] = []) {
    return {
      id: area.id,
      name: area.name,
      icon: area.icon,
      color: area.color,
      description: area.description,
      tools: this.parse<AreaTool[]>(area.tools, []),
      sourceUrl: area.sourceUrl,
      createdAt: area.createdAt,
      jobCount: jobs.length,
      jobs: jobs.map((j) => ({
        id: j.id, name: j.name, icon: j.icon, color: j.color, description: j.description,
        enabled: j.enabled, scheduleText: j.scheduleText, category: j.category,
        lastRun: j._lastRun || null,
      })),
    };
  }

  /** All areas with their jobs + each job's last run (one call for the new home, BEA-1098). */
  async list() {
    const [areas, agents, lastRuns] = await Promise.all([
      (this.prisma as any).agentArea.findMany({ orderBy: { createdAt: 'desc' } }),
      this.prisma.agent.findMany({ orderBy: { createdAt: 'desc' } }),
      this.prisma.agentRun.findMany({
        where: { agentId: { not: null } },
        orderBy: { startedAt: 'desc' },
        take: 300,
        select: { agentId: true, status: true, startedAt: true, endedAt: true },
      }),
    ]);
    const lastByAgent = new Map<string, any>();
    for (const r of lastRuns) if (r.agentId && !lastByAgent.has(r.agentId)) lastByAgent.set(r.agentId, { status: r.status, at: r.endedAt || r.startedAt });
    const byArea = new Map<string, any[]>();
    for (const a of agents as any[]) {
      (a as any)._lastRun = lastByAgent.get(a.id) || null;
      const key = (a as any).areaId || '';
      if (!byArea.has(key)) byArea.set(key, []);
      byArea.get(key)!.push(a);
    }
    return areas.map((ar: any) => this.shape(ar, byArea.get(ar.id) || []));
  }

  async get(id: string) {
    const area = await (this.prisma as any).agentArea.findUnique({ where: { id } });
    if (!area) throw new NotFoundException('Agent not found');
    const jobs = await this.prisma.agent.findMany({ where: { areaId: id } as any, orderBy: { createdAt: 'desc' } });
    return this.shape(area, jobs as any[]);
  }

  async create(input: { name?: string; icon?: string; color?: string; description?: string; tools?: AreaTool[]; sourceUrl?: string }) {
    if (!input?.name?.trim()) throw new BadRequestException('An agent needs a name');
    const area = await (this.prisma as any).agentArea.create({
      data: {
        name: input.name.trim().slice(0, 120),
        icon: input.icon || null,
        color: input.color?.trim() || null,
        description: input.description?.trim() || null,
        tools: JSON.stringify(this.cleanTools(input.tools)),
        sourceUrl: input.sourceUrl?.trim() || null,
      },
    });
    return this.shape(area);
  }

  async update(id: string, patch: { name?: string; icon?: string; color?: string; description?: string; tools?: AreaTool[]; sourceUrl?: string }) {
    const data: any = {};
    if (patch.name !== undefined) data.name = patch.name.trim().slice(0, 120) || undefined;
    if (patch.icon !== undefined) data.icon = patch.icon || null;
    if (patch.color !== undefined) data.color = patch.color?.trim() || null;
    if (patch.description !== undefined) data.description = patch.description?.trim() || null;
    if (patch.tools !== undefined) data.tools = JSON.stringify(this.cleanTools(patch.tools));
    if (patch.sourceUrl !== undefined) data.sourceUrl = patch.sourceUrl?.trim() || null;
    const area = await (this.prisma as any).agentArea.update({ where: { id }, data }).catch(() => { throw new NotFoundException('Agent not found'); });
    return this.shape(area);
  }

  /** Delete an area. Jobs (and their history) go ONLY with the explicit withJobs flag (BEA-1109). */
  async remove(id: string, opts: { withJobs?: boolean } = {}) {
    const jobs = await this.prisma.agent.findMany({ where: { areaId: id } as any, select: { id: true } });
    if (jobs.length > 0 && !opts.withJobs) throw new BadRequestException('This agent still has jobs. Move or delete them first — their history is precious.');
    if (opts.withJobs) {
      for (const j of jobs as any[]) {
        if (this.agentSvc) await this.agentSvc.deleteAgent(j.id).catch(() => undefined); // runs + flows go too (BEA-1113)
        else {
          await this.prisma.agentRun.deleteMany({ where: { agentId: j.id } }).catch(() => undefined);
          await this.prisma.agent.delete({ where: { id: j.id } }).catch(() => undefined);
        }
      }
    }
    await (this.prisma as any).agentArea.delete({ where: { id } }).catch(() => { throw new NotFoundException('Agent not found'); });
    return { ok: true, jobsDeleted: opts.withJobs ? jobs.length : 0 };
  }

  /** Move a job into another area (the owner regrouping — e.g. OKF under Research Agent). */
  async moveJob(jobId: string, areaId: string) {
    const [job, area] = await Promise.all([
      this.prisma.agent.findUnique({ where: { id: jobId } }),
      (this.prisma as any).agentArea.findUnique({ where: { id: areaId } }),
    ]);
    if (!job) throw new NotFoundException('Job not found');
    if (!area) throw new NotFoundException('Target agent not found');
    const fromAreaId = (job as any).areaId;
    await this.prisma.agent.update({ where: { id: jobId }, data: { areaId } as any });
    // A one-job area left empty by the move is removed quietly — it was just the migration wrapper.
    if (fromAreaId && fromAreaId !== areaId) {
      const left = await this.prisma.agent.count({ where: { areaId: fromAreaId } as any });
      if (left === 0) await (this.prisma as any).agentArea.delete({ where: { id: fromAreaId } }).catch(() => undefined);
    }
    return { ok: true, areaId };
  }

  private cleanTools(tools?: AreaTool[]): AreaTool[] {
    if (!Array.isArray(tools)) return [];
    const KINDS = ['skill', 'api', 'mcp', 'cli'];
    return tools.slice(0, 40).map((t: any): AreaTool => ({
      // Keep the catalog id — without it a picked tool is just a label again (BEA-1167).
      ...(t?.id ? { id: String(t.id).slice(0, 120) } : {}),
      kind: KINDS.includes(t?.kind) ? t.kind : 'api',
      name: String(t?.name || '').slice(0, 80),
      ...(t?.note ? { note: String(t.note).slice(0, 200) } : {}),
      status: t?.status === 'installed' ? ('installed' as const) : ('needed' as const),
    })).filter((t) => t.name);
  }
}
