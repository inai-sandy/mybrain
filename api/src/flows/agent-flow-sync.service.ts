import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService, AgentFlowSync } from '../agent/agent.service';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { planActionIds, planFromAgent } from '../social/plan';
import { buildSocialFlow, isDirectFetchAgent, SocialFlowNames } from '../social/social-flow';
import { FlowsService } from './flows.service';

/**
 * Every agent shows its flow picture, automatically (BEA-1366).
 *
 * Registered with `AgentService` at boot (`setFlowSync`) — AgentModule cannot import FlowsModule, so
 * the agent side only knows a seam. `afterSave()` runs after every create / update:
 *
 *  • a **Social agent** (direct runner — every tool a `svc:` id with pinned arguments) gets its
 *    picture BUILT from its settings by `buildSocialFlow()`: no AI, a few milliseconds, saved locked
 *    and `drawnBy:'social'`. Any save that touches what runs (sources, arguments, task, output,
 *    sheet, WhatsApp, mode, condition, threshold, name) redraws it; nothing else does.
 *  • **every other agent** is planned by the existing generator (`FlowsService.planAndSave`) on
 *    create and whenever its task text changes — in the BACKGROUND, because a plan is one or two
 *    model calls and the save must answer now. The flow row exists at once with `drawStatus:
 *    'drawing'`, so the job page can say so; a plan that fails keeps the last picture and says
 *    "could not re-draw" (that rule lives in `planAndSave`).
 *
 * Back-fill: at boot every Social agent without a current picture is drawn once (cheap, idempotent
 * — a graph that already matches is not rewritten). Legacy normal agents are NOT planned at boot —
 * that would be a model call per agent for nobody watching; they keep the "Draw the flow" button
 * until they are next saved.
 */
@Injectable()
export class AgentFlowSyncService implements OnModuleInit, AgentFlowSync {
  private readonly log = new Logger('AgentFlowSync');
  /** flowId → "plan again when this one finishes" — two quick saves never race two planners. */
  private readonly inflight = new Map<string, boolean>();

  /** Saves of a Social agent that change what runs — and so the picture. */
  static readonly SOCIAL_KEYS = ['tools', 'toolArgs', 'outputDest', 'sheetId', 'sheetAppend', 'notifyWhatsApp', 'mode', 'prompt', 'alertCondition', 'threshold', 'name'];
  /** Saves of any other agent that re-plan the picture (a rename or a pause does not). */
  static readonly PLAN_KEYS = ['prompt'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly flows: FlowsService,
    // Optional + LAST — spec files build this positionally with fewer args.
    private readonly agentSvc?: AgentService,
    private readonly catalog?: ToolCatalogService,
  ) {}

  onModuleInit() {
    this.agentSvc?.setFlowSync?.(this);
    // A deploy mid-plan leaves a flow saying 'drawing' with nobody drawing (the planner's state is in
    // this process). Same rule as the AgentRun reconciler: on boot those become 'failed — try again',
    // so the panel's spinner ends and its Re-draw button comes back.
    void this.reconcileStuckDrawing().catch(() => undefined);
    // Boot back-fill after the stampede has settled; never blocks boot, never throws out.
    const t = setTimeout(() => { this.backfillSocial().catch((e) => this.log.warn(`back-fill failed: ${e?.message || e}`)); }, 15_000);
    if (typeof (t as any).unref === 'function') (t as any).unref();
  }

  /** Flows left `drawStatus:'drawing'` by a restart → 'failed' + the note (nothing is drawing them). */
  async reconcileStuckDrawing(): Promise<number> {
    const r = await this.prisma.flow?.updateMany?.({ where: { drawStatus: 'drawing' } as any, data: { drawStatus: 'failed', drawNote: FlowsService.REDRAW_FAILED_NOTE } as any });
    const n = Number(r?.count) || 0;
    if (n) this.log.warn(`${n} flow${n === 1 ? '' : 's'} left mid-draw by a restart — marked "could not re-draw"`);
    return n;
  }

  /** The seam `AgentService` calls after every create / update. Never throws. */
  async afterSave(agent: any, ctx: { created: boolean; changed: string[] }): Promise<void> {
    try {
      if (!agent?.id) return;
      if (isDirectFetchAgent(agent)) {
        if (!ctx.created && !ctx.changed.some((k) => AgentFlowSyncService.SOCIAL_KEYS.includes(k))) return;
        await this.drawSocial(agent);
        return;
      }
      if (!ctx.created && !ctx.changed.some((k) => AgentFlowSyncService.PLAN_KEYS.includes(k))) return;
      await this.planNormal(agent);
    } catch (e: any) {
      this.log.warn(`could not draw the flow for ${agent?.id}: ${e?.message || e}`);
    }
  }

  /**
   * A Social agent's picture, from its settings. Idempotent: an unchanged graph is not rewritten
   * (so the boot back-fill does not bump every flow's `updatedAt`). Returns the flow, or null when
   * nothing needed writing.
   */
  async drawSocial(agent: any): Promise<any | null> {
    // Two quick saves of the same agent draw in arrival order (a slower, older draw must not land
    // on top of a newer one) — one chain per agent id.
    const prev = this.socialChain.get(agent.id) || Promise.resolve();
    const mine = prev.catch(() => undefined).then(() => this.drawSocialNow(agent));
    this.socialChain.set(agent.id, mine);
    try { return await mine; } finally { if (this.socialChain.get(agent.id) === mine) this.socialChain.delete(agent.id); }
  }
  private readonly socialChain = new Map<string, Promise<any>>();

  private async drawSocialNow(agent: any): Promise<any | null> {
    // Every action the plan calls — sources, and a creators-first block's finder + per-creator action (BEA-1369).
    const tools: string[] = planActionIds(planFromAgent(agent));
    const [names, costs] = await Promise.all([this.namesFor(tools), this.costsFor(tools)]);
    const built = buildSocialFlow(agent, { names, costs });
    const existing = (await this.flows.list(agent.id))[0] || null;
    // A hand-drawn locked flow (BEA-1259) is never overwritten, in this direction either.
    if (existing?.locked && existing.drawnBy !== 'social') { this.log.warn(`agent ${agent.id} has a hand-drawn locked flow — not redrawing it from settings`); return null; }
    if (existing && existing.drawnBy === 'social' && existing.name === built.name && JSON.stringify(existing.graph) === JSON.stringify(built.graph)) return null;
    return this.flows.saveDrawn({ flowId: existing?.id, agentId: agent.id, name: built.name, question: built.question, graph: built.graph, drawnBy: 'social' });
  }

  /**
   * Any other agent: make sure a linked flow exists with the task as its question, then plan it in
   * the background. A hand-drawn locked flow (AI News Daily, BEA-1259) is never re-planned.
   */
  async planNormal(agent: any): Promise<void> {
    const prompt = String(agent.prompt || '').trim();
    if (!prompt) return; // nothing to plan from yet
    let flow: any = (await this.flows.list(agent.id))[0] || null;
    if (!flow) {
      flow = await this.flows.create({ name: `${String(agent.name || 'Job').trim()} flow`, question: prompt, agentId: agent.id });
    } else {
      if (flow.locked && flow.drawnBy !== 'social') return; // hand-drawn and locked: leave it alone
      // A job that stopped being a direct fetch (its sources were removed) is planned like any other —
      // the machine-drawn lock comes off first.
      const data: any = {};
      if ((flow.question || '') !== prompt) data.question = prompt;
      if (flow.drawnBy === 'social') { data.locked = false; data.drawnBy = null; }
      if (Object.keys(data).length) await this.prisma.flow.update({ where: { id: flow.id }, data }).catch(() => undefined);
    }
    await this.prisma.flow.update({ where: { id: flow.id }, data: { drawStatus: 'drawing', drawNote: null } as any }).catch(() => undefined);
    void this.planInBackground(flow.id);
  }

  /** One planner per flow at a time; a save that lands mid-plan queues exactly one more plan. */
  private async planInBackground(flowId: string): Promise<void> {
    if (this.inflight.has(flowId)) { this.inflight.set(flowId, true); return; }
    this.inflight.set(flowId, false);
    try {
      await this.flows.planAndSave(flowId);
    } catch (e: any) {
      // The planner threw (engine down, flow deleted…): the last picture stays; say so on the flow.
      await this.prisma.flow.update({ where: { id: flowId }, data: { drawStatus: 'failed', drawNote: FlowsService.REDRAW_FAILED_NOTE } as any }).catch(() => undefined);
      this.log.warn(`plan failed for flow ${flowId}: ${e?.message || e}`);
    }
    const again = this.inflight.get(flowId);
    this.inflight.delete(flowId);
    if (again) void this.planInBackground(flowId);
  }

  /**
   * Draw (or re-draw) one agent's picture on request — the Flow tab's "Draw the flow" / "Re-draw"
   * button, one road for both kinds: a Social agent is rebuilt from its settings, any other agent is
   * (re)planned in the background. Returns the flow as it stands right after (a normal agent's says
   * `drawStatus:'drawing'`), or null when there is nothing to draw from yet (no task).
   */
  async drawFor(agentId: string): Promise<any | null> {
    const agent: any = await this.agentSvc?.getAgent?.(agentId);
    if (!agent) throw new NotFoundException('Agent not found');
    if (isDirectFetchAgent(agent)) await this.drawSocial(agent);
    else await this.planNormal(agent);
    return (await this.flows.list(agentId))[0] || null;
  }

  /** Boot: every Social agent gets its picture (idempotent — see drawSocial). Returns how many were (re)drawn. */
  async backfillSocial(): Promise<number> {
    const agents: any[] = (await this.agentSvc?.listAgents?.()) || [];
    let drawn = 0;
    for (const a of agents) {
      if (!isDirectFetchAgent(a)) continue;
      try { if (await this.drawSocial(a)) drawn++; } catch (e: any) { this.log.warn(`back-fill: could not draw ${a.id}: ${e?.message || e}`); }
    }
    if (drawn) this.log.log(`back-fill: drew ${drawn} Social flow${drawn === 1 ? '' : 's'}`);
    return drawn;
  }

  /** Plain names per `svc:` id from the one catalog ("Instagram: Search hashtag"). Best effort. */
  private async namesFor(tools: string[]): Promise<SocialFlowNames> {
    const out: SocialFlowNames = {};
    if (!tools.length) return out;
    const cat = await this.catalog?.catalog?.().catch(() => null);
    if (!cat) return out;
    for (const t of cat.tools || []) {
      if (!tools.includes(t.id)) continue;
      const i = String(t.name || '').indexOf(': ');
      if (i > 0) out[t.id] = { service: t.name.slice(0, i), action: t.name.slice(i + 2) };
    }
    return out;
  }

  /** The last real cost of each action (`ToolCall.credits`) — the same hint the budget check uses. Best effort. */
  private async costsFor(tools: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const id of tools) {
      try {
        const last = await this.prisma.toolCall?.findFirst?.({ where: { action: id, ok: true, credits: { not: null } }, orderBy: { createdAt: 'desc' }, select: { credits: true } });
        if (last && Number.isFinite(Number(last.credits))) out[id] = Number(last.credits);
      } catch { /* no hint */ }
    }
    return out;
  }
}
