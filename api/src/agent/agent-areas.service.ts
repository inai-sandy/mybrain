import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from './agent.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { shortlistForPrompt } from '../tools/tool-shortlist';
import { ToolKnowledge, ToolKnowledgeService } from '../tools/tool-knowledge.service';
import { AgentPlan, PlanCost, estimatePlanCost } from '../social/plan';
import { TOP_BUILDER_SESSION, builderSettingKey } from './builder-session';
import { BuilderSampleService } from './builder-sample.service';
import {
  BLOCKS_TEXT, DesignCounter, RULES_TEXT, SAMPLE_LOOPS_PER_MESSAGE, SAMPLE_TEXT, TURN_MAX_TOKENS, TURN_TIMEOUT_MS, budgetLine, estimateTokens, factsSection,
  fillTemplate, healthNote, indexSection, overBudget, parseBuilderJson, pickCardIds, planToAgentInput, readDesignCounter, sampleRequestOf, sampleViewText, validatePlan,
} from './thinking-builder';
import { isServiceToolId } from '../tools/service-provider';

// `id` is the catalog id (BEA-1167) — present when the tool was picked from the one catalog, absent
// on the older hand-typed entries. It is what makes a toolbox mean something at run time.
export type AreaTool = { id?: string; kind: 'skill' | 'api' | 'mcp' | 'cli'; group?: string; name: string; note?: string; status?: 'installed' | 'needed' };

/**
 * What a builder conversation keeps in its Setting row (BEA-1370/1371): the log, the ordinary
 * proposal (`spec` for the top-level builder, `job` for a job builder), the direct-fetch `plan` with
 * its `cost`, the sample counter and the design-budget counter. A reset drops all of it.
 */
export type BuilderState = { log: any[]; spec?: any | null; job?: any | null; plan?: AgentPlan | null; cost?: PlanCost | null; samples?: any; design?: DesignCounter };

function packState(st: BuilderState): string {
  return JSON.stringify({
    log: (st.log || []).slice(-40),
    ...(st.spec !== undefined ? { spec: st.spec } : {}),
    ...(st.job !== undefined ? { job: st.job } : {}),
    plan: st.plan || null,
    cost: st.cost || null,
    ...(st.samples ? { samples: st.samples } : {}),
    ...(st.design ? { design: st.design } : {}),
  });
}

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
    private readonly catalog?: ToolCatalogService, // the one tool catalog (BEA-1167)
    private readonly sampler?: BuilderSampleService, // "look for yourself" (BEA-1370) — LAST, optional
    private readonly knowledge?: ToolKnowledgeService, // the know-how cards the builder reads (BEA-1368/1371)
  ) {}

  /**
   * The one permanent Research Agent (BEA-1110) — the collector for one-time research jobs from
   * bookmarks, voice, anywhere. Found by name (never duplicated), created on first need.
   */
  async ensureResearchAgent(): Promise<{ id: string; created?: boolean }> {
    const rows = await (this.prisma as any).agentArea.findMany({ select: { id: true, name: true } });
    const hit = rows.find((r: any) => String(r.name).trim().toLowerCase() === 'research agent');
    if (hit) return { id: hit.id, created: false };
    const area = await this.create({
      name: 'Research Agent', icon: '🔬', color: '#22d3ee',
      description: 'Deep-dives you ask for — from bookmarks, voice, anywhere. One report per job.',
      // Deep research MUST be in the standing toolbox (BEA-1252). Flows are planned inside the
      // job's toolbox, and jobs without their own fall back to this one — leaving deep_research
      // out meant every research job under this agent could only plan shallow, single-index
      // searches. The owner's own re-planned flow proved it live.
      tools: [
        { id: 'deep_research', name: 'Deep research', group: 'Web', kind: 'api', note: 'Many searches across every index, reads the best pages, writes a cited report', status: 'installed' },
        { id: 'web_search', name: 'Web search', group: 'Web', kind: 'api', note: 'Search the live web', status: 'installed' },
        { id: 'web_read', name: 'Read a page', group: 'Web', kind: 'api', note: 'Open a link and read what it says', status: 'installed' },
        { id: 'search_brain', name: 'Search my brain', group: 'Brain', kind: 'api', note: 'Everything you have saved — notes, documents and memories, searched by meaning', status: 'installed' },
        { id: 'save_document', name: 'Save to Documents', group: 'Output', kind: 'api', note: 'Write the result into your document library', status: 'installed' },
      ] as any,
    });
    return { id: area.id, created: true };
  }

  // ---- The NEW-JOB chat (BEA-1170) --------------------------------------------------------------
  // Adding a job used to be a silent form: one box, one AI call, then eight pre-filled fields. This
  // is a real conversation instead — it asks until it understands, and only then builds the job.
  // Kept per area so two half-finished chats can't overwrite each other.

  private jobKey(areaId: string) { return builderSettingKey(areaId); }

  // `samples` is the sample-call counter (BEA-1370, `BuilderSampleService`) — carried through untouched
  // here so a chat turn never forgets what was already tried; a reset drops it on purpose. `plan`,
  // `cost` and `design` (the design-budget counter) are the thinking builder's (BEA-1371).
  private async jobLoad(areaId: string): Promise<BuilderState> {
    const row = await this.prisma.setting.findUnique({ where: { key: this.jobKey(areaId) } }).catch(() => null);
    try { const v = row ? JSON.parse(row.value) : null; return { log: v?.log || [], job: v?.job || null, plan: v?.plan || null, cost: v?.cost || null, samples: v?.samples, design: v?.design }; } catch { return { log: [], job: null, plan: null, cost: null }; }
  }
  private async jobSave(areaId: string, st: BuilderState) {
    await this.prisma.setting.upsert({ where: { key: this.jobKey(areaId) }, create: { key: this.jobKey(areaId), value: packState(st) }, update: { value: packState(st) } });
  }
  async jobBuilderState(areaId: string) { return this.jobLoad(areaId); }
  async jobBuilderReset(areaId: string) { await this.jobSave(areaId, { log: [], job: null, plan: null, cost: null }); return { ok: true }; }

  /** One turn of the new-job conversation — the thinking builder (BEA-1371). */
  async jobBuilderChat(areaId: string, message: string): Promise<{ reply: string; job: any | null; plan: AgentPlan | null; cost: PlanCost | null }> {
    const msg = (message || '').trim().slice(0, 2000);
    if (!msg) throw new BadRequestException('Say something first.');
    const area: any = await this.get(areaId);
    const agentBlurb = [
      `Name: ${area.name}`,
      area.description ? `What it is for: ${area.description}` : '',
      (area.tools || []).length ? `Its usual tools: ${(area.tools || []).map((t: any) => t.name).join(', ')}` : '',
      (area.jobs || []).length ? `Jobs it already has: ${(area.jobs || []).map((j: any) => j.name).join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const st = await this.think({
      sessionKey: areaId,
      promptKey: 'agent.jobBuilder',
      load: () => this.jobLoad(areaId),
      save: (x) => this.jobSave(areaId, x),
      message: msg,
      vars: { agent: { label: 'The agent this job belongs to', text: agentBlurb } },
      proposalKey: 'job',
      keepProposal: (g) => (g && typeof g === 'object' && g.name && g.task ? g : null),
      label: 'agent-job-builder',
    });
    return { reply: st.reply, job: st.state.job, plan: st.state.plan || null, cost: st.state.cost || null };
  }

  /** Build the job the owner just approved. `overrides` carries their tool ticks (BEA-1171). */
  async jobBuilderCreate(areaId: string, overrides?: { tools?: string[]; checks?: string[] }) {
    const st = await this.jobLoad(areaId);
    if (!this.agentSvc) throw new BadRequestException('Agent service unavailable.');

    // A DIRECT job (BEA-1371): the plan IS the job — the same fields `planFromAgent` reads back, so
    // the runner and the flow picture see exactly what the builder showed.
    if (st.plan) {
      const input = planToAgentInput(st.plan, await this.socialTester(st.plan));
      const created: any = await this.agentSvc.createAgent({ ...input, areaId } as any);
      st.log.push({ who: 'ai', text: `Created ✓ — "${created.name}".`, at: new Date().toISOString() });
      st.job = null; st.plan = null; st.cost = null;
      await this.jobSave(areaId, st);
      return { ok: true as const, jobId: created.id, url: `/agent/a/${created.id}`, name: created.name };
    }

    const j = st.job;
    if (!j?.name || !j?.task) throw new BadRequestException('There is no job to create yet — keep chatting.');

    const proposedTools: string[] = Array.isArray(j.tools) ? j.tools.map((t: any) => (typeof t === 'string' ? t : t?.id)).filter(Boolean) : [];
    const tools = Array.isArray(overrides?.tools) ? overrides!.tools! : proposedTools;
    let checks: string[] = Array.isArray(overrides?.checks) ? overrides!.checks! : (Array.isArray(j.checks) ? j.checks : []);
    checks = checks.map((c: any) => String(c).trim()).filter(Boolean);
    // A job with nothing to check against can never be graded (BEA-1172/1173). If the conversation
    // produced an Outcome but no checks, use the Outcome itself as the one check — derived from what
    // they actually said, not invented.
    if (!checks.length && j.outcome) checks = [String(j.outcome).trim().slice(0, 300)];

    // Tools + WhatsApp go in WITH the create (BEA-1366): the flow is planned on save, inside the
    // job's toolbox — a patch straight after would have planned it against no toolbox at all.
    const created: any = await this.agentSvc.createAgent({
      areaId,
      name: String(j.name).trim().slice(0, 120),
      icon: j.icon || undefined,
      prompt: String(j.task).trim(),
      rubric: j.outcome ? String(j.outcome).slice(0, 2000) : undefined,
      defaultDepth: ['quick', 'standard', 'deep'].includes(j.depth) ? j.depth : undefined,
      schedule: j.schedule && typeof j.schedule === 'object' ? j.schedule : undefined,
      scheduleText: j.scheduleText || undefined,
      evals: checks.slice(0, 12).map((input: any) => ({ id: 'ev_' + Math.random().toString(36).slice(2, 9), input: String(input).slice(0, 300) })),
      ...(tools.length ? { tools: tools.slice(0, 60) } : {}),
      ...(j.notifyWhatsApp != null ? { notifyWhatsApp: !!j.notifyWhatsApp } : {}),
    } as any);

    st.log.push({ who: 'ai', text: `Created ✓ — "${created.name}".`, at: new Date().toISOString() });
    st.job = null; st.plan = null; st.cost = null;
    await this.jobSave(areaId, st);
    return { ok: true as const, jobId: created.id, url: `/agent/a/${created.id}`, name: created.name };
  }

  // ---- The thinking builder's turn (BEA-1371) — shared by both chat builders ---------------------
  //
  // One owner message → (facts for the shortlisted tools) → the model → maybe a sample (≤ 3 rounds,
  // ③'s caps hold, the 🔎 line lands in the log) → a reply, and maybe a validated plan with its cost.
  // The design budget (turns + tokens per conversation) is counted here; over it, the model is told
  // to propose the best plan it has instead of asking more.

  private async think(o: {
    sessionKey: string;
    promptKey: 'agent.builder' | 'agent.jobBuilder';
    load: () => Promise<BuilderState>;
    save: (st: BuilderState) => Promise<void>;
    message: string;
    vars: Record<string, { label: string; text: string }>;
    /** 'spec' (top-level: area + jobs) or 'job' — the ordinary, engine-run proposal beside the plan. */
    proposalKey: 'spec' | 'job';
    keepProposal: (g: any) => any | null;
    label: string;
  }): Promise<{ reply: string; state: BuilderState }> {
    let st = await o.load();
    st.log.push({ who: 'you', text: o.message, at: new Date().toISOString() });
    await o.save(st); // the owner's line is down before any sample line can land after it
    const cantDo = "I couldn't work that out — try saying it another way.";
    const design: DesignCounter = readDesignCounter(st);
    let spentTokens = 0;
    try {
      const tpl = (await this.promptsSvc?.get(o.promptKey).catch(() => '')) || '';
      const convo = () => st.log.slice(-24).map((m: any) => `${m.who === 'you' ? 'OWNER' : 'YOU'}: ${m.text}`).join('\n');

      // ---- the tools that fit, and their cards ---------------------------------------------------
      const cat = await this.catalog?.catalog().catch(() => null);
      const shortlist = shortlistForPrompt((cat?.tools || []).filter((t: any) => t.connected), convo());
      const cardIds = pickCardIds(shortlist as any, convo());
      const cards: ToolKnowledge[] = cardIds.length ? await this.knowledge?.lookup(cardIds).catch(() => []) || [] : [];
      const cardsById: Record<string, ToolKnowledge> = Object.fromEntries(cards.map((c) => [c.actionId, c]));
      const plainTools = shortlist.filter((t: any) => !String(t.id).startsWith('svc:')).map((t: any) => `- ${t.id} (${t.group}) — ${t.name}: ${t.description}`).join('\n') || '(none)';
      // The actions that got no card are still LISTED (id — name), so the model knows they exist and can
      // sample one; the plan may use any id it was shown (card or index) — never one it made up.
      const index = indexSection(shortlist as any, convo(), cards.map((c) => c.actionId));
      const allowedIds = new Set([...cards.map((c) => c.actionId), ...shortlist.filter((t: any) => isServiceToolId(t.id)).map((t: any) => t.id)]);

      const previous = st.plan ? `\n\nThe plan you last proposed (refine it, don't start over):\n${JSON.stringify(st.plan)}` : st[o.proposalKey] ? `\n\nThe ${o.proposalKey} you last proposed (refine it, don't start over):\n${JSON.stringify(st[o.proposalKey])}` : '';
      const buildPrompt = (extra: string) => fillTemplate(tpl, {
        conversation: { label: 'The conversation so far', text: convo() },
        ...o.vars,
        facts: { label: 'WHAT THE TOOLS CAN REALLY DO (know-how cards)', text: factsSection(cards, convo()) + (index ? `\n\nOTHER OUTSIDE-SERVICE ACTIONS you were not shown a card for (id — name). They exist; sample one before you plan on it:\n${index}` : '') },
        tools: { label: 'Other tools (exact ids)', text: plainTools },
        blocks: { label: 'Planning blocks', text: BLOCKS_TEXT },
        sample: { label: 'Look for yourself', text: SAMPLE_TEXT },
        budget: { label: 'Design budget', text: budgetLine(design) },
        rules: { label: 'Rules', text: RULES_TEXT },
      }) + previous + extra;

      const ask = async (extra: string): Promise<any> => {
        const prompt = buildPrompt(extra);
        const text = await this.llm?.completeHelper('agent-builder', prompt, TURN_MAX_TOKENS, o.label, { timeoutMs: TURN_TIMEOUT_MS });
        spentTokens += estimateTokens(prompt) + estimateTokens(text || '');
        return parseBuilderJson(text);
      };

      // ---- the loop: sample rounds, then a plan check --------------------------------------------
      let extra = '';
      let g: any = null;
      for (let round = 0; round <= SAMPLE_LOOPS_PER_MESSAGE; round++) {
        g = await ask(extra);
        const want = sampleRequestOf(g);
        if (!want) break;
        if (round === SAMPLE_LOOPS_PER_MESSAGE || overBudget(design) || !this.sampler) {
          extra += `\n\nNo more samples for this message${!this.sampler ? ' (sampling is not available here)' : ''} — answer the owner now from what you know.`;
          g = await ask(extra);
          break;
        }
        const view = await this.sampler.sample(o.sessionKey, want.actionId, want.args);
        // The sampler wrote its 🔎 line and counter into the SAME row — pick them up, keep our proposal.
        const fresh = await o.load();
        st = { ...st, log: fresh.log, samples: fresh.samples };
        extra += `\n\n${sampleViewText(view)}\nNow continue: another sample only if it settles something the owner would otherwise be asked; else answer.`;
      }

      let reply = String(g?.reply || '').trim().slice(0, 2400);
      let plan: AgentPlan | null = null;
      let cost: PlanCost | null = null;
      if (g?.plan && typeof g.plan === 'object') {
        let check = validatePlan(g.plan, allowedIds);
        if (!check.plan) {
          // Once: tell the model what was wrong; a second miss falls back to the reply alone.
          const fixed = await ask(`${extra}\n\nYour "plan" did not validate: ${check.errors.join('; ')}. Send the whole JSON again with the plan fixed (same reply is fine).`);
          if (fixed?.plan && typeof fixed.plan === 'object') check = validatePlan(fixed.plan, allowedIds);
          if (check.plan && fixed?.reply) reply = String(fixed.reply).trim().slice(0, 2400);
        }
        if (check.plan) {
          plan = check.plan;
          cost = estimatePlanCost(plan, cardsById as any);
        }
      }
      // Budget spent and still no plan: keep the best plan so far rather than asking on.
      if (!plan && overBudget(design) && st.plan) { plan = st.plan; cost = st.cost || estimatePlanCost(plan, cardsById as any); if (!reply) reply = 'Here is the best plan I have from what we said — press Create when happy, or tell me one thing to change.'; }
      if (!reply) reply = cantDo;
      // Honesty: a plan that leans on a failing source says so, even when the model forgot.
      const note = healthNote(plan, cardsById, reply);
      if (note) reply = `${reply}\n\n${note}`;

      // One proposal at a time: a plan (direct agent) replaces an ordinary proposal and the other way
      // round, so Create never has to guess which one the owner is looking at.
      const proposal = o.keepProposal(g?.[o.proposalKey]);
      if (plan) { st.plan = plan; st.cost = cost; (st as any)[o.proposalKey] = null; }
      else if (proposal) { (st as any)[o.proposalKey] = proposal; st.plan = null; st.cost = null; }
      st.design = { turns: design.turns + 1, tokens: design.tokens + spentTokens };
      st.log.push({ who: 'ai', text: reply, at: new Date().toISOString() });
      await o.save(st);
      return { reply, state: st };
    } catch {
      st.design = { turns: design.turns + 1, tokens: design.tokens + spentTokens };
      st.log.push({ who: 'ai', text: cantDo, at: new Date().toISOString() });
      await o.save(st);
      return { reply: cantDo, state: st };
    }
  }

  /** `id → is it a social-provider action?` for the plan's category, from the cards it was planned with. */
  private async socialTester(plan: AgentPlan): Promise<((id: string) => boolean) | undefined> {
    const ids = [...new Set(plan.sources.flatMap((s) => (s.kind === 'source' ? [s.actionId] : [s.find.actionId, s.then.actionId])))].filter(Boolean);
    const cards = ids.length ? await this.knowledge?.lookup(ids).catch(() => []) || [] : [];
    if (!cards.length) return undefined;
    const social = new Set(cards.filter((c) => c.provider === 'social').map((c) => c.actionId));
    const known = new Set(cards.map((c) => c.actionId));
    return (id: string) => known.has(id) && social.has(id);
  }

  // ---- The in-app chat builder (BEA-1104): a persisted conversation that designs a new agent. ----

  private builderKey() { return builderSettingKey(TOP_BUILDER_SESSION); }

  private async builderLoad(): Promise<BuilderState> {
    const row = await this.prisma.setting.findUnique({ where: { key: this.builderKey() } }).catch(() => null);
    try { const v = row ? JSON.parse((row as any).value) : null; return { log: v?.log || [], spec: v?.spec || null, plan: v?.plan || null, cost: v?.cost || null, samples: v?.samples, design: v?.design }; } catch { return { log: [], spec: null, plan: null, cost: null }; }
  }
  // `samples` = the sample-call counter (BEA-1370); kept across turns, dropped by `builderReset()`.
  private async builderSave(st: BuilderState) {
    await this.prisma.setting.upsert({ where: { key: this.builderKey() }, create: { key: this.builderKey(), value: packState(st) }, update: { value: packState(st) } });
  }

  async builderState() { return this.builderLoad(); }
  async builderReset() { await this.builderSave({ log: [], spec: null, plan: null, cost: null }); return { ok: true }; }

  /** One builder turn: owner's message → the thinking builder's reply (+ the evolving spec or plan). */
  async builderChat(message: string): Promise<{ reply: string; spec: any | null; plan: AgentPlan | null; cost: PlanCost | null }> {
    const msg = (message || '').trim().slice(0, 2000);
    if (!msg) throw new BadRequestException('Say something first.');
    const st = await this.think({
      sessionKey: TOP_BUILDER_SESSION,
      promptKey: 'agent.builder',
      load: () => this.builderLoad(),
      save: (x) => this.builderSave(x),
      message: msg,
      vars: {},
      proposalKey: 'spec',
      keepProposal: (g) => (g && typeof g === 'object' && g.area?.name ? g : null),
      label: 'agent-builder',
    });
    return { reply: st.reply, spec: st.state.spec, plan: st.state.plan || null, cost: st.state.cost || null };
  }

  /** Create the agent from the current proposal (the owner pressed Create). */
  async builderCreate() {
    const st = await this.builderLoad();
    // A DIRECT agent (BEA-1371): one job from the plan, its own area, the flow picture drawn from the
    // same fields — `createAgent` without an area gives the job an area of the same name.
    if (st.plan) {
      if (!this.agentSvc) throw new BadRequestException('Agent service unavailable.');
      const input = planToAgentInput(st.plan, await this.socialTester(st.plan));
      const created: any = await this.agentSvc.createAgent(input as any);
      st.log.push({ who: 'ai', text: `Created ✓ — "${created.name}".`, at: new Date().toISOString() });
      st.plan = null; st.cost = null;
      await this.builderSave(st);
      return { ok: true as const, areaId: created.areaId, agentId: created.id, url: `/agent/a/${created.id}`, jobs: [{ id: created.id, name: created.name }] };
    }
    if (!st.spec) throw new BadRequestException('There is no proposal to create yet — keep chatting.');
    const res = await this.createFromSpec(st.spec);
    st.log.push({ who: 'ai', text: `Created ✓ — "${st.spec.area.name}" with ${res.jobs.length} job(s).`, at: new Date().toISOString() });
    st.spec = null; st.plan = null; st.cost = null;
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
      outcome: area.outcome || '', // the agent's standing definition of done (BEA-1173)
      tools: this.parse<AreaTool[]>(area.tools, []),
      sourceUrl: area.sourceUrl,
      createdAt: area.createdAt,
      jobCount: jobs.length,
      jobs: jobs.map((j) => ({
        id: j.id, name: j.name, icon: j.icon, color: j.color, description: j.description,
        enabled: j.enabled, scheduleText: j.scheduleText, category: j.category,
        origin: j.origin || 'chat', // where it came from — chat, voice or an import (BEA-1176)
        createdAt: j.createdAt,
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
        select: { agentId: true, status: true, startedAt: true, endedAt: true, grade: true },
      }),
    ]);
    void lastRuns; // superseded by attachLastRun, which also counts flow runs (BEA-1176)
    await this.attachLastRun(agents as any[]);
    const byArea = new Map<string, any[]>();
    for (const a of agents as any[]) {
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
    // The agent page used to compute NO last run at all, so every job read "never ran" — even one
    // that was running right then. (BEA-1176)
    await this.attachLastRun(jobs as any[]);
    return this.shape(area, jobs as any[]);
  }

  /**
   * Hang each job's most recent run on the row — status, when, and how it was graded.
   *
   * A job's work can happen EITHER as a direct agent run or as a flow run (anything deep, and every
   * voice job, runs as a flow). Looking at only one of the two is why a job that was running right
   * then still read "never ran". (BEA-1176)
   */
  private async attachLastRun(jobs: any[]): Promise<void> {
    const ids = jobs.map((j) => j.id);
    if (!ids.length) return;

    const [agentRuns, flows] = await Promise.all([
      Promise.resolve((this.prisma as any).agentRun?.findMany?.({
        where: { agentId: { in: ids } },
        orderBy: { startedAt: 'desc' },
        take: 300,
        select: { agentId: true, status: true, startedAt: true, endedAt: true, grade: true },
      })).catch(() => [] as any[]),
      // Optional-call: spec harnesses build a partial prisma without these delegates.
      Promise.resolve((this.prisma as any).flow?.findMany?.({ where: { agentId: { in: ids } }, select: { id: true, agentId: true } })).catch(() => [] as any[]),
    ]);

    const best = new Map<string, any>();
    const consider = (agentId: string | null, row: { status: string; at: any; grade?: any }) => {
      if (!agentId || !row.at) return;
      const cur = best.get(agentId);
      if (!cur || new Date(row.at).getTime() > new Date(cur.at).getTime()) best.set(agentId, row);
    };
    for (const r of (agentRuns || []) as any[]) consider(r.agentId, { status: r.status, at: r.endedAt || r.startedAt, grade: this.parse<any>(r.grade, null) });

    const agentByFlow = new Map<string, string>(((flows || []) as any[]).map((f) => [f.id, f.agentId]));
    if (agentByFlow.size) {
      const flowRuns = await Promise.resolve((this.prisma as any).flowRun?.findMany?.({
        where: { flowId: { in: [...agentByFlow.keys()] } },
        orderBy: { startedAt: 'desc' },
        take: 300,
        select: { flowId: true, status: true, startedAt: true, endedAt: true },
      })).catch(() => [] as any[]);
      for (const r of (flowRuns || []) as any[]) consider(agentByFlow.get(r.flowId) || null, { status: r.status, at: r.endedAt || r.startedAt });
    }

    for (const j of jobs) j._lastRun = best.get(j.id) || null;
  }

  /**
   * Copy an agent's identity, toolbox and standing Outcome as a starting point (BEA-1182).
   * Its JOBS and history are deliberately NOT copied — you want the shape, not the work.
   */
  async duplicate(id: string) {
    const src: any = await (this.prisma as any).agentArea.findUnique({ where: { id } });
    if (!src) throw new NotFoundException('Agent not found');
    const existing: any[] = await (this.prisma as any).agentArea.findMany({ select: { name: true } });
    const taken = new Set(existing.map((a) => String(a.name)));
    let name = `${src.name} copy`;
    for (let i = 2; taken.has(name); i++) name = `${src.name} copy ${i}`;
    const made = await (this.prisma as any).agentArea.create({
      data: { name: name.slice(0, 120), icon: src.icon, color: src.color, description: src.description, outcome: src.outcome, tools: src.tools || '[]' },
    });
    return this.shape(made, []);
  }

  async create(input: { name?: string; icon?: string; color?: string; description?: string; outcome?: string; tools?: AreaTool[]; sourceUrl?: string }) {
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

  async update(id: string, patch: { name?: string; icon?: string; color?: string; description?: string; outcome?: string; tools?: AreaTool[]; sourceUrl?: string }) {
    const data: any = {};
    if (patch.name !== undefined) data.name = patch.name.trim().slice(0, 120) || undefined;
    if (patch.icon !== undefined) data.icon = patch.icon || null;
    if (patch.color !== undefined) data.color = patch.color?.trim() || null;
    if (patch.description !== undefined) data.description = patch.description?.trim() || null;
    if (patch.tools !== undefined) data.tools = JSON.stringify(this.cleanTools(patch.tools));
    if ((patch as any).outcome !== undefined) data.outcome = ((patch as any).outcome || '').trim().slice(0, 2000) || null;
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
    // Its half-finished new-job conversation goes too (BEA-1191). Nothing reads an orphaned one, but
    // each holds up to 40 messages and they would pile up forever — the same "cleanup happens in one
    // place and not the parallel one" shape that caused today's task bugs.
    await Promise.resolve((this.prisma as any).setting?.delete?.({ where: { key: this.jobKey(id) } })).catch(() => undefined);
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
      ...(t?.group ? { group: String(t.group).slice(0, 40) } : {}), // the catalog group, for the badge
      kind: KINDS.includes(t?.kind) ? t.kind : 'api',
      name: String(t?.name || '').slice(0, 80),
      ...(t?.note ? { note: String(t.note).slice(0, 200) } : {}),
      status: t?.status === 'installed' ? ('installed' as const) : ('needed' as const),
    })).filter((t) => t.name);
  }
}
