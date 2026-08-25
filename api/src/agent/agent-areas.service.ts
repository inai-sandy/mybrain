import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from './agent.service';
import { LlmService } from '../llm/llm.service';
import { TokenBudgetError } from '../llm/token-budget.service';
import { PromptsService } from '../prompts/prompts.service';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { shortlistForPrompt } from '../tools/tool-shortlist';
import { ToolKnowledge, ToolKnowledgeService } from '../tools/tool-knowledge.service';
import { AgentPlan, PlanCost, costLineText, estimatePlanCost, planHasHealthySource } from '../social/plan';
import { SAMPLE_CAPS, TOP_BUILDER_SESSION, builderSettingKey, readSampleCounter } from './builder-session';
import { BuilderSampleService } from './builder-sample.service';
import {
  BLOCKS_TEXT, DesignCounter, RULES_TEXT, SAMPLE_LOOPS_PER_MESSAGE, SAMPLE_TEXT, TURN_MAX_TOKENS, TURN_TIMEOUT_MS, budgetLine, cardText, estimateTokens, factsSection,
  fillTemplate, healthNote, indexSection, overBudget, pickCardIds, planToAgentInput, readDesignCounter, sampleRequestOf, sampleViewText, validatePlan,
  BuilderSeed, MAX_ASKS_PER_MESSAGE, costReplyLine, goalMissingNote, goalOf, isExpensivePlan, noGoalText, noHealthySourceText, sampleFinderText, sampledActionIds,
  seedLine, seedText, unsampledFinderNote, unsampledFinders, withGoal,
  AMBIGUOUS_TEXT, PROSE_REPLY_MIN, SHAPE_RETRY_TEXT, THINKING_FAILED_TEXT, TROUBLE_TEXT, TurnRead, TurnTrouble, proseFallbackReply, readTurn,
} from './thinking-builder';
import { isServiceToolId } from '../tools/service-provider';
import { LOOKUP_TEXT, ToolLookupService, lookupRequestOf, lookupText } from '../tools/tool-lookup.service';
/**
 * The chat designs nothing (BEA-1466).
 *
 * A constant rather than a setting: the owner asked for one behaviour, not a switch, and a switch
 * would be one more place for the two roads to disagree. The brief machinery below it stays intact
 * because his nine existing agents were built through it and still run on it — this only stops the
 * CHAT from feeding it.
 */
const CHAT_ONLY = true;

import { BRIEF_TEXT, BriefProblem, ProposedBrief, briefCardOf, briefHeldNote, briefRequestOf, checkProposedBrief, readProposedBrief } from './brief-turn';
import { BriefService } from './brief.service';

/**
 * How many times the builder may look something up per message he sends (BEA-1417).
 *
 * A lookup costs nothing at a vendor — it reads the catalog we already hold — but it costs a model
 * call each, and a builder browsing forty actions is one that has not understood the job. Enough to
 * find what it needs, not enough to wander.
 */
const LOOKUPS_PER_MESSAGE = 6;

// `id` is the catalog id (BEA-1167) — present when the tool was picked from the one catalog, absent
// on the older hand-typed entries. It is what makes a toolbox mean something at run time.
export type AreaTool = { id?: string; kind: 'skill' | 'api' | 'mcp' | 'cli'; group?: string; name: string; note?: string; status?: 'installed' | 'needed' };

/**
 * What a builder conversation keeps in its Setting row (BEA-1370/1371): the log, the ordinary
 * proposal (`spec` for the top-level builder, `job` for a job builder), the direct-fetch `plan` with
 * its `cost`, the sample counter and the design-budget counter. A reset drops all of it.
 */
export type BuilderState = { log: any[]; spec?: any | null; job?: any | null; plan?: AgentPlan | null; cost?: PlanCost | null; samples?: any; design?: DesignCounter; seed?: BuilderSeed | null; goal?: string | null; brief?: ProposedBrief | null; /** The action ids HE named (BEA-1466) — the one thing the chat still collects. */ tools?: string[] };

function packState(st: BuilderState): string {
  return JSON.stringify({
    log: (st.log || []).slice(-40),
    ...(st.spec !== undefined ? { spec: st.spec } : {}),
    ...(st.job !== undefined ? { job: st.job } : {}),
    plan: st.plan || null,
    cost: st.cost || null,
    ...(st.samples ? { samples: st.samples } : {}),
    ...(st.design ? { design: st.design } : {}),
    ...(st.seed ? { seed: st.seed } : {}),
    // What the result is FOR, in the owner's words (BEA-1378) — set by the model's `goal` field,
    // read by the stakes gate, shown on the plan card, carried onto the created agent.
    ...(st.goal ? { goal: st.goal } : {}),
    // What he will actually read and approve (BEA-1424). It lives here until he opens it, exactly
    // as `plan` does — a brief with no home yet belongs to the conversation that wrote it.
    brief: st.brief || null,
  });
}

/**
 * Agent AREAS (BEA-1095) — the container the owner thinks of as "an agent" (Research Agent,
 * Daily News). An area holds a visible Tools list and many jobs (Agent rows). Jobs keep living in
 * the Agent table so every run/flow/waitpoint reference keeps working untouched.
 */
@Injectable()
export class AgentAreasService {
  // A builder turn that goes wrong must leave a trace with the cause in it (BEA-1402) — the catch
  // below used to swallow every error and the owner got one shrug that named nothing.
  private readonly log = new Logger('AgentAreas');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentSvc?: AgentService, // optional + LAST — spec files construct positionally
    private readonly llm?: LlmService,
    private readonly promptsSvc?: PromptsService,
    private readonly catalog?: ToolCatalogService, // the one tool catalog (BEA-1167)
    private readonly sampler?: BuilderSampleService, // "look for yourself" (BEA-1370) — LAST, optional
    private readonly knowledge?: ToolKnowledgeService, // the know-how cards the builder reads (BEA-1368/1371)
    private readonly lookup?: ToolLookupService,
    private readonly briefs?: BriefService, // where a brief the conversation wrote goes to live (BEA-1424)
  ) {}

  onModuleInit() {
    // How a fact card is written out for a model lives here, with the prompt words (BEA-1417).
    // `ToolCatalogModule` may not import this module, so it is registered rather than injected —
    // the same `setFlowSync` / `setBudget` seam the rest of the app already uses.
    this.lookup?.setCardWriter?.((card) => cardText(card));
  }

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
    // Same rule as the top-level builder's loader: a field `packState` writes and this does not read
    // is saved and silently dropped (BEA-1424).
    try { const v = row ? JSON.parse(row.value) : null; return { log: v?.log || [], job: v?.job || null, plan: v?.plan || null, cost: v?.cost || null, samples: v?.samples, design: v?.design, goal: v?.goal || null, brief: v?.brief || null, tools: v?.tools || [] }; } catch { return { log: [], job: null, plan: null, cost: null }; }
  }
  private async jobSave(areaId: string, st: BuilderState) {
    await this.prisma.setting.upsert({ where: { key: this.jobKey(areaId) }, create: { key: this.jobKey(areaId), value: packState(st) }, update: { value: packState(st) } });
  }
  async jobBuilderState(areaId: string) { return this.jobLoad(areaId); }
  async jobBuilderReset(areaId: string) { await this.jobSave(areaId, { log: [], job: null, plan: null, cost: null }); return { ok: true }; }

  /** One turn of the new-job conversation — the thinking builder (BEA-1371). */
  async jobBuilderChat(areaId: string, message: string): Promise<{ reply: string; job: any | null; plan: AgentPlan | null; cost: PlanCost | null; goal: string | null; tools: string[] }> {
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
    return { reply: st.reply, job: st.state.job, plan: st.state.plan || null, cost: st.state.cost || null, goal: st.state.goal || null, tools: st.state.tools || [] };
  }

  /** Build the job the owner just approved. `overrides` carries their tool ticks (BEA-1171). */
  async jobBuilderCreate(areaId: string, overrides?: { tools?: string[]; checks?: string[] }) {
    const st = await this.jobLoad(areaId);
    if (!this.agentSvc) throw new BadRequestException('Agent service unavailable.');

    // A DIRECT job (BEA-1371): the plan IS the job — the same fields `planFromAgent` reads back, so
    // the runner and the flow picture see exactly what the builder showed.
    if (st.plan) {
      const input = planToAgentInput(st.plan, await this.socialTester(st.plan));
      // The goal rides onto the job as "For: <goal>" on its description (BEA-1378).
      const description = withGoal(null, st.goal);
      const created: any = await this.agentSvc.createAgent({ ...input, areaId, ...(description ? { description } : {}) } as any);
      st.log.push({ who: 'ai', text: `Created ✓ — "${created.name}".`, at: new Date().toISOString() });
      st.job = null; st.plan = null; st.cost = null; st.goal = null;
      await this.jobSave(areaId, st);
      return { ok: true as const, jobId: created.id, url: `/agent/a/${created.id}`, name: created.name };
    }

    // ONE ROAD (BEA-1453). The old `job` road made a job switched ON, with no brief to read and no
    // run to watch, and a third model drew its flow afterwards. New jobs go through the brief.
    if (st.brief) {
      const area = await this.get(areaId).catch(() => null);
      const saved = await this.persistBrief(areaId, st.brief, st.log || []);
      st.log.push({ who: 'ai', text: 'The brief is ready to read — nothing is built yet.', at: new Date().toISOString() });
      st.brief = null; st.job = null; st.plan = null; st.cost = null;
      await this.jobSave(areaId, st);
      return { ok: true as const, briefId: saved.id, url: `/agent/ar/${areaId}/brief`, name: String((area as any)?.name || saved.name || 'this agent') };
    }

    const j = st.job;
    if (j?.name && j?.task) {
      throw new BadRequestException(
        'This conversation is from the older way of building jobs, which made them without showing you anything first. Start a new one and I will write you a brief you can read, and run it once before you keep it.',
      );
    }
    throw new BadRequestException('There is no brief to open yet — keep chatting, and I will write one when I understand the job.');
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
    const design: DesignCounter = readDesignCounter(st);
    let spentTokens = 0;
    // What the LAST model answer was, so a turn with nothing to show says which thing went wrong
    // instead of the one shrug (BEA-1402).
    const turn: { trouble: TurnTrouble; prose: string } = { trouble: 'none', prose: '' };
    const where = () => `prompt ${o.promptKey} · session ${o.sessionKey} · turn ${design.turns + 1} · ≈${spentTokens.toLocaleString('en-US')} tokens spent this turn`;
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

      // The goal — what the result is FOR, in the owner's words (BEA-1378). Carried in the state, set by
      // the model's `goal` field on any answer this turn; the prompt shows it so it is never re-asked.
      let goal: string | null = st.goal || null;

      // The last plan rides along with ITS server cost, so a refinement quotes the server's numbers, never its own (BEA-1375).
      const previous = st.plan ? `\n\nThe plan you last proposed (refine it, don't start over):\n${JSON.stringify(st.plan)}${st.cost ? `\nServer cost of that plan (quote these, not your own): ${costLineText(st.cost)}` : ''}` : st[o.proposalKey] ? `\n\nThe ${o.proposalKey} you last proposed (refine it, don't start over):\n${JSON.stringify(st[o.proposalKey])}` : '';
      const buildPrompt = (extra: string) => fillTemplate(tpl, {
        conversation: { label: 'The conversation so far', text: convo() },
        ...o.vars,
        facts: { label: 'WHAT THE TOOLS CAN REALLY DO (know-how cards)', text: factsSection(cards, convo()) + (index ? `\n\nOTHER OUTSIDE-SERVICE ACTIONS you were not shown a card for (id — name). They exist; sample one before you plan on it:\n${index}` : '') },
        tools: { label: 'Other tools (exact ids)', text: plainTools },
        blocks: { label: 'Planning blocks', text: `${BLOCKS_TEXT}\n\n${BRIEF_TEXT}` },
        sample: { label: 'Look for yourself', text: `${SAMPLE_TEXT}\n\n${LOOKUP_TEXT}` },
        budget: { label: 'Design budget', text: budgetLine(design) },
        rules: { label: 'Rules', text: RULES_TEXT },
        // The Social hand-off (BEA-1372): the call the owner just made by hand — an empty text is not appended.
        seed: { label: 'Where the owner came from', text: seedText(st.seed) },
        // The goal already established (BEA-1378) — so a later turn never re-asks what it is for.
        goal: { label: 'What the result is FOR (the owner already said — do not ask again; keep it in your "goal" field)', text: goal || '' },
      }) + previous + extra;

      // One model call, read and CLASSIFIED (BEA-1402): a `cut-off` or `unreadable` answer is said
      // out loud in the log with the prompt, the session and what it cost, so the next one of these
      // can be diagnosed from the container's own words instead of guessed at.
      const ask = async (extra: string): Promise<any> => {
        const prompt = buildPrompt(extra);
        const text = await this.llm?.completeHelper('agent-builder', prompt, TURN_MAX_TOKENS, o.label, { timeoutMs: TURN_TIMEOUT_MS });
        spentTokens += estimateTokens(prompt) + estimateTokens(text || '');
        const read: TurnRead = readTurn(text);
        turn.trouble = read.trouble;
        turn.prose = read.prose;
        if (turn.trouble !== 'none') this.log.warn(`${o.label}: the model's answer was ${turn.trouble} (${String(text || '').length} chars back, ${TURN_MAX_TOKENS} token ceiling) — ${where()}`);
        return read.g;
      };

      // ---- the loop: sample rounds and plan checks ------------------------------------------------
      // The model may ask for a sample (≤ SAMPLE_LOOPS_PER_MESSAGE per owner message) and a plan it sends
      // is checked before it is shown: it must validate (one fix round), it must have a HEALTHY source
      // (one round to add a fallback), and a creators block's finder must have been sampled in this
      // conversation (one nudge — the model answers with a sample, which the same loop runs). Each check
      // sends the model back at most ONCE (BEA-1375); a plan that still fails is not shown — reply only.
      let extra = '';
      let g: any = null;
      let asks = 0;
      let samplesRun = 0;
      let lookups = 0;
      let plan: AgentPlan | null = null;
      let refused: AgentPlan | null = null;
      // An expensive plan held back because no goal is established (BEA-1378) — its cost writes the note.
      let heldForGoal: PlanCost | null = null;
      const nudged = { invalid: false, health: false, finder: false, goal: false, shape: false, brief: false };
      let brief: ProposedBrief | null = null;
      // A brief that is still wrong after its one send-back: NOT shown, and he is told what is
      // missing in his own terms rather than being handed something half-written.
      let refusedBrief: BriefProblem | null = null;
      const canSample = () => !!this.sampler && !overBudget(design) && readSampleCounter(st).used < SAMPLE_CAPS.calls;
      // An answer we could read nothing out of — cut off at the output ceiling, or simply not the
      // shape asked for. ONE re-ask, shorter and in shape, before the owner is told (BEA-1402). A
      // service that answered nothing at all is not re-asked: that is a second call for nothing.
      const rescue = (): boolean => {
        if (nudged.shape || turn.trouble === 'no-answer' || asks >= MAX_ASKS_PER_MESSAGE) return false;
        nudged.shape = true;
        extra += `\n\n${SHAPE_RETRY_TEXT}`;
        return true;
      };
      while (asks < MAX_ASKS_PER_MESSAGE) {
        g = await ask(extra); asks++;
        if (!g) { if (rescue()) continue; break; }
        // The goal may arrive on ANY answer this turn — a plan beside it counts as goal-established.
        const said = goalOf(g);
        if (said) goal = said;
        // "What tools do I actually have?" (BEA-1417) — the builder asks instead of being handed my
        // shortlist of fifty. A search narrows; only an exact fetch may be planned on, which is why
        // `fetched` is what widens `allowedIds` and a search result never does.
        const ask2 = lookupRequestOf(g);
        if (ask2 && this.lookup) {
          if (lookups >= LOOKUPS_PER_MESSAGE) {
            extra += `\n\nNo more lookups for this message — plan with what you have now.`;
          } else {
            lookups++;
            const answer = ask2.what === 'services'
              ? { services: await this.lookup.services().catch(() => []) }
              : ask2.what === 'actions'
                ? { actions: await this.lookup.findActions(ask2.service || '', ask2.words || '').catch(() => []) }
                : { action: await this.lookup.getAction(ask2.actionId || '').catch(() => null) };
            // Only an EXACT fetch may be planned on. A name from a search proves nothing.
            if (ask2.what === 'action' && (answer as any).action?.id) allowedIds.add(String((answer as any).action.id));
            extra += `\n\n${lookupText(ask2, answer as any)}\nNow continue.`;
            continue;
          }
        }

        const want = sampleRequestOf(g);
        if (want) {
          if (samplesRun >= SAMPLE_LOOPS_PER_MESSAGE || !canSample()) {
            if (asks >= MAX_ASKS_PER_MESSAGE) break;
            extra += `\n\nNo more samples for this message${!this.sampler ? ' (sampling is not available here)' : ''} — answer the owner now from what you know.`;
            g = await ask(extra); asks++;
            // The forced answer gets the same one rescue as any other (review fix, BEA-1402).
            if (!g) { if (rescue()) continue; break; }
            if (sampleRequestOf(g)) break; // still asking → nothing to show
          } else {
            samplesRun++;
            const view = await this.sampler!.sample(o.sessionKey, want.actionId, want.args);
            // The sampler wrote its 🔎 line and counter into the SAME row — pick them up, keep our proposal.
            const fresh = await o.load();
            st = { ...st, log: fresh.log, samples: fresh.samples };
            extra += `\n\n${sampleViewText(view)}\nNow continue: another sample only if it settles something the owner would otherwise be asked; else answer.`;
            continue;
          }
        }
        // A BRIEF (BEA-1424) — what he reads and approves, and the only thing that gets built. Checked
        // here rather than trusted: the prompt asks for these things, and this builder has talked its
        // way past a prompt four times over. One send-back per reason, never a loop.
        // THE CHAT ONLY CHATS (BEA-1466). The prompt says the brief field is always null; this is
        // what makes it true whatever the model sends, because this builder has talked its way past
        // a prompt more than once. A brief that arrives now is DROPPED, silently and on purpose —
        // it is not an error he needs to see, it is a habit being unlearned. What he wants goes to
        // Codex as the conversation itself, and Codex writes the goal (BEA-1463).
        const rawBrief = CHAT_ONLY ? null : briefRequestOf(g);
        if (rawBrief) {
          const proposed = readProposedBrief(rawBrief);
          if (!proposed) {
            if (nudged.brief) break;
            nudged.brief = true;
            extra += '\n\nYour "brief" could not be read. Send it again in the shape shown above — sections with lines, each line carrying its own origin.';
            continue;
          }
          const wrong = checkProposedBrief(proposed, sampledActionIds(st));
          if (wrong) {
            if (nudged.brief) { refusedBrief = wrong; break; }
            nudged.brief = true;
            extra += `\n\n${wrong.say}`;
            continue;
          }
          brief = proposed;
          break;
        }

        // Same for a plan — the eight boxes are gone and the chat may not resurrect them.
        if (CHAT_ONLY) break;
        if (!g?.plan || typeof g.plan !== 'object') break;
        const check = validatePlan(g.plan, allowedIds);
        if (!check.plan) {
          if (nudged.invalid) break;
          nudged.invalid = true;
          extra += `\n\nYour "plan" did not validate: ${check.errors.join('; ')}. Send the whole JSON again with the plan fixed (same reply is fine).`;
          continue;
        }
        // A validated plan supersedes anything held in an EARLIER round — only THIS plan's blocking
        // reason may write the reply's note, or a revised plan that fixed its health would still be
        // called "every source is failing" while it waits for the goal (review fix, BEA-1378).
        refused = null;
        heldForGoal = null;
        // A plan of only failing sources is an empty sheet today — not shown (BEA-1375).
        if (!planHasHealthySource(check.plan, cardsById as any)) {
          refused = check.plan;
          if (nudged.health) break;
          nudged.health = true;
          extra += `\n\n${noHealthySourceText(check.plan, cardsById)}`;
          continue;
        }
        // A creators block on a finder the conversation never looked at → sample it first (BEA-1375).
        const finders = unsampledFinders(check.plan, sampledActionIds(st));
        if (finders.length && !nudged.finder && canSample() && samplesRun < SAMPLE_LOOPS_PER_MESSAGE) {
          nudged.finder = true;
          extra += `\n\n${sampleFinderText(finders)}`;
          continue;
        }
        // The stakes gate (BEA-1378): an expensive plan (by the SERVER's own estimate) with no goal
        // established in the conversation is not shown — same mechanism as the healthy-source rule.
        if (!goal) {
          const est = this.costWithHealth(check.plan, cardsById);
          if (isExpensivePlan(est)) {
            heldForGoal = est;
            if (nudged.goal) break;
            nudged.goal = true;
            extra += `\n\n${noGoalText(est)}`;
            continue;
          }
        }
        plan = check.plan;
        refused = null;
        heldForGoal = null;
        break;
      }

      // `g` is the model's LATEST answer — after a fix round its reply is the one that goes with the plan.
      let reply = String(g?.reply || '').trim().slice(0, 2400);
      let cost: PlanCost | null = plan ? this.costWithHealth(plan, cardsById) : null;
      // Budget spent and still no plan: keep the best plan so far rather than asking on.
      if (!plan && !refused && !heldForGoal && overBudget(design) && st.plan) { plan = st.plan; cost = st.cost || this.costWithHealth(plan, cardsById); if (!reply) reply = 'Here is the best plan I have from what we said — press Create when happy, or tell me one thing to change.'; }
      if (!reply) reply = this.troubleReply(turn.trouble, turn.prose, `${o.label}: ${where()}`);
      // A brief held back after its one send-back: he reads WHY, in plain words, instead of being
      // shown something that is missing the part that matters (BEA-1424).
      if (refusedBrief) reply = `${reply}\n\nI have not written the brief yet — ${briefHeldNote(refusedBrief)}`;
      // Honesty: a plan that leans on a failing source says so, even when the model forgot; a refused plan
      // (no healthy source) says why no card came.
      const note = healthNote(plan || refused, cardsById, reply);
      if (note) reply = `${reply}\n\n${note}`;
      // An expensive plan held back for the goal (BEA-1378): the owner reads why no plan card came.
      if (!plan && heldForGoal) reply = `${reply}\n\n${goalMissingNote(heldForGoal)}`;
      // A creators finder the conversation never looked at and cannot look at now (sample budget spent): said plainly.
      const unseen = plan ? unsampledFinderNote(unsampledFinders(plan, sampledActionIds(st)), cardsById) : '';
      if (unseen) reply = `${reply}\n\n${unseen}`;
      // The cost line under the reply is the SERVER's — the same figures as the card, both of them while a
      // source is down — so the reply and the card can never disagree (BEA-1375).
      const costLine = costReplyLine(cost);
      if (plan && costLine) reply = `${reply}\n\n${costLine}`;

      // One proposal at a time: a plan (direct agent) replaces an ordinary proposal and the other way
      // round, so Create never has to guess which one the owner is looking at.
      const proposal = o.keepProposal(g?.[o.proposalKey]);
      if (brief) { st.brief = brief; st.plan = null; st.cost = null; (st as any)[o.proposalKey] = null; }
      else if (plan) { st.plan = plan; st.cost = cost; st.brief = null; (st as any)[o.proposalKey] = null; }
      else if (proposal) { (st as any)[o.proposalKey] = proposal; st.plan = null; st.cost = null; st.brief = null; }
      st.goal = goal; // remembered for every later turn, the gate, the card and Create (BEA-1378)
      // The tools he NAMED (BEA-1466). The prompt has asked for these since the chat stopped
      // designing, and nothing was carrying them — so `namedTools` was always empty, Codex was told
      // about no actions at all, and the first real run failed with "I could not find a Gmail
      // action". Kept only when the model sends a list; a turn that mentions none must not wipe what
      // he named three turns ago.
      if (Array.isArray(g?.tools)) {
        st.tools = g.tools.map((t: any) => String(t || '').trim()).filter((t: string) => t.startsWith('svc:'));
      }
      st.design = { turns: design.turns + 1, tokens: design.tokens + spentTokens };
      st.log.push({ who: 'ai', text: reply, at: new Date().toISOString() });
      await o.save(st);
      return { reply, state: st };
    } catch (e: any) {
      // A budget stop is a real answer, not a puzzle (BEA-1373): the owner read "try saying it another
      // way" three times while the day's AI budget was simply used up — say the reason and the remedy.
      let reply: string;
      if (e instanceof TokenBudgetError) reply = `I have stopped for now — ${e.message}`;
      else {
        // The catch that swallowed everything (BEA-1402). The cause goes to the log WITH the prompt,
        // the session, the turn and the spend; the owner gets a sentence that says what happened.
        this.log.error(`${o.label}: the turn threw — ${String(e?.message || e)} · ${where()}`, e?.stack || undefined);
        reply = THINKING_FAILED_TEXT;
      }
      st.design = { turns: design.turns + 1, tokens: design.tokens + spentTokens };
      st.log.push({ who: 'ai', text: reply, at: new Date().toISOString() });
      await o.save(st);
      return { reply, state: st };
    }
  }

  /**
   * A turn with nothing to say: WHICH thing went wrong, in the owner's words (BEA-1402).
   *
   * "Try saying it another way" is only honest when the model really did answer and left its reply
   * empty — a genuinely ambiguous message. Every other road names itself: the AI service answered
   * nothing, the answer stopped mid-way, or it came back in a shape we could not read. And when a
   * shape-less answer still holds plain words meant for the owner, he reads THOSE — losing his turn
   * to a shrug when the model actually wrote him a paragraph is the bug this exists to remove.
   */
  private troubleReply(trouble: TurnTrouble, prose: string, at: string): string {
    if (trouble === 'none') return AMBIGUOUS_TEXT;
    const words = String(prose || '').trim();
    // Either kind of broken answer can still carry plain words meant for him — a lead-in sentence
    // before a half-written plan counts (review fix, BEA-1402). Only "nothing came back" cannot.
    const showProse = trouble !== 'no-answer' && words.length >= PROSE_REPLY_MIN;
    this.log.error(`no reply for the owner — the model's answer was ${trouble}${showProse ? ' (its plain words were shown instead)' : ''} · ${at}`);
    return showProse ? proseFallbackReply(words, trouble) : TROUBLE_TEXT[trouble];
  }

  /** The estimate plus the failing sources it leans on — the plan card marks them (BEA-1372). */
  private costWithHealth(plan: AgentPlan, cardsById: Record<string, ToolKnowledge>): PlanCost {
    // The cards carry name + health, so the estimate itself fills `unhealthy` and `nowCredits` (BEA-1375).
    return estimatePlanCost(plan, cardsById as any);
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
    // Every field is named on BOTH sides. `packState` writing a field that this does not read means
    // it is saved and then silently dropped — which is exactly what happened to `brief` (BEA-1424):
    // the conversation wrote one, it went into the row, and Create said "there is no proposal yet".
    try { const v = row ? JSON.parse((row as any).value) : null; return { log: v?.log || [], spec: v?.spec || null, plan: v?.plan || null, cost: v?.cost || null, samples: v?.samples, design: v?.design, seed: v?.seed || null, goal: v?.goal || null, brief: v?.brief || null }; } catch { return { log: [], spec: null, plan: null, cost: null }; }
  }
  // `samples` = the sample-call counter (BEA-1370); kept across turns, dropped by `builderReset()`.
  private async builderSave(st: BuilderState) {
    await this.prisma.setting.upsert({ where: { key: this.builderKey() }, create: { key: this.builderKey(), value: packState(st) }, update: { value: packState(st) } });
  }

  async builderState() {
    const st = await this.builderLoad();
    return { ...st, brief: st.brief ? briefCardOf(st.brief) : null };
  }
  async builderReset() { await this.builderSave({ log: [], spec: null, plan: null, cost: null, brief: null }); return { ok: true }; }

  /**
   * "Make it an agent" on a Social result (BEA-1372): a FRESH conversation whose first line is the builder's
   * own — "You just ran X (args) and got N posts. Is this the kind of thing you want, and how much of it?" —
   * scripted, so it costs no model call; the seed (id + exact args + compact answer) rides into every later
   * turn's prompt through `seedText()`. Seeding the same call again is a no-op (a page reload must not wipe
   * the conversation); a different call starts over.
   */
  async builderSeed(input: BuilderSeed) {
    // Seeds are serialised: two equal POSTs at once (a double tap, two tabs) must not both read "no seed yet" and write twice.
    const run = this.seedChain.then(() => this.seedOnce(input));
    this.seedChain = run.catch(() => undefined);
    return run;
  }
  private seedChain: Promise<any> = Promise.resolve();

  private async seedOnce(input: BuilderSeed) {
    const actionId = String(input?.actionId || '').trim();
    if (!/^svc:[a-z0-9_]+\.[a-z0-9_]+$/.test(actionId)) throw new BadRequestException('Say which action was run.');
    const args = input?.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args : {};
    if (JSON.stringify(args).length > 4000) throw new BadRequestException('Those arguments are too long to start from.');
    const s = input?.sample && typeof input.sample === 'object' ? input.sample : undefined;
    const seed: BuilderSeed = {
      actionId,
      args,
      ...(input?.label ? { label: String(input.label).slice(0, 120) } : {}),
      ...(s ? { sample: {
        ...(typeof s.count === 'number' && Number.isFinite(s.count) ? { count: Math.max(0, Math.floor(s.count)) } : {}),
        ...(s.listKey ? { listKey: String(s.listKey).slice(0, 60) } : {}),
        ...(typeof s.credits === 'number' && Number.isFinite(s.credits) ? { credits: Math.max(0, s.credits) } : {}),
        ...(s.notFound ? { notFound: true } : {}),
        ...(Array.isArray(s.fields) ? { fields: s.fields.map((f: any) => String(f)).filter(Boolean).slice(0, 12) } : {}),
      } } : {}),
    };
    const current = await this.builderLoad();
    const same = current.seed && current.seed.actionId === seed.actionId && JSON.stringify(current.seed.args || {}) === JSON.stringify(seed.args) && current.log.length > 0;
    if (same) return current;
    const st: BuilderState = { log: [{ who: 'ai', kind: 'seed', text: seedLine(seed), at: new Date().toISOString() }], spec: null, plan: null, cost: null, seed };
    await this.builderSave(st);
    return st;
  }

  /** One builder turn: owner's message → the thinking builder's reply (+ the evolving spec or plan). */
  async builderChat(message: string): Promise<{ reply: string; spec: any | null; plan: AgentPlan | null; cost: PlanCost | null; goal: string | null; brief: ReturnType<typeof briefCardOf> | null; tools: string[] }> {
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
    // Only the CARD goes over the wire (BEA-1424) — the brief itself has its own screen, and putting
    // the whole thing in a chat bubble is how it becomes the wall of text he scrolls past.
    return { reply: st.reply, spec: st.state.spec, plan: st.state.plan || null, cost: st.state.cost || null, goal: st.state.goal || null, brief: st.state.brief ? briefCardOf(st.state.brief) : null, tools: st.state.tools || [] };
  }

  /** Create the agent from the current proposal (the owner pressed Create). `folderId` = the folder the owner was inside (BEA-1380). */
  /**
   * Give a brief the conversation wrote a real home (BEA-1424).
   *
   * Line ids come from the store, not from the model — a model-invented id would collide the first
   * time it repeated itself, and every edit and strike-out on the screen is keyed by it.
   */
  private async persistBrief(areaId: string, proposed: ProposedBrief, log: any[]) {
    if (!this.briefs) throw new BadRequestException('Briefs are not available on this server.');
    const draft = await this.briefs.draft(areaId, proposed.name);
    // Attach the PROOF (BEA-1424). The conversation really did look — the sampler wrote a line with
    // the `ToolCall` id on it — but the model's own brief cannot know that id, so the sources it
    // proposed carried nothing. The stored brief then refused its own approval: "I have not looked
    // at Instagram myself yet", about a source it had just fetched twelve posts from.
    const proof = new Map<string, string>();
    for (const m of log || []) {
      if (m?.kind === 'sample' && m?.ok && m?.actionId && m?.callId) proof.set(String(m.actionId), String(m.callId));
    }
    return this.briefs.update(draft.id, {
      name: proposed.name,
      sections: proposed.sections,
      sources: proposed.sources.map((s) => (proof.has(s.actionId) ? { ...s, evidence: { callId: proof.get(s.actionId)!, actionId: s.actionId } } : s)),
      // What it WRITES with (BEA-1453). Written on one side and not the other is how a field gets
      // saved and silently dropped — three times in one night, so: named here too.
      tools: proposed.tools || [],
      schedule: proposed.schedule || null,
      delivery: proposed.delivery,
      // The WHOLE conversation goes with it — his decision, 2026-08-22: Codex reads all of it, and
      // the brief sitting on top is what makes that safe.
      transcript: (log || []).map((m: any) => ({
        id: '',
        who: m?.who === 'you' ? 'you' : 'ai',
        text: String(m?.text || ''),
        at: String(m?.at || ''),
        ...(m?.kind ? { kind: String(m.kind) } : {}),
      })),
    });
  }

  async builderCreate(opts: { folderId?: string | null } = {}) {
    const st = await this.builderLoad();
    const folderId = await this.folderIdOrNull(opts.folderId);
    // A BRIEF (BEA-1424) — the road he actually goes down now. Nothing is built here: the brief gets
    // a home so he can open it, read it, and watch it run once. Keeping it is a later tap, on the
    // trial's own result, which is the whole point of the second gate.
    if (st.brief) {
      const area: any = await this.create({ name: st.brief.name || 'New agent', ...(folderId ? { folderId } : {}) });
      const saved = await this.persistBrief(String(area.id), st.brief, st.log || []);
      st.log.push({ who: 'ai', text: `The brief is ready to read — nothing is built yet.`, at: new Date().toISOString() });
      st.brief = null; st.plan = null; st.cost = null; st.seed = null;
      await this.builderSave(st);
      return { ok: true as const, areaId: String(area.id), briefId: saved.id, url: `/agent/ar/${area.id}/brief`, jobs: [] };
    }
    // A DIRECT agent (BEA-1371): one job from the plan, its own area, the flow picture drawn from the
    // same fields — `createAgent` without an area gives the job an area of the same name.
    if (st.plan) {
      if (!this.agentSvc) throw new BadRequestException('Agent service unavailable.');
      const input = planToAgentInput(st.plan, await this.socialTester(st.plan));
      // The goal rides onto the agent as "For: <goal>" on its description (BEA-1378).
      const description = withGoal(null, st.goal);
      const created: any = await this.agentSvc.createAgent({ ...input, ...(description ? { description } : {}), ...(folderId ? { folderId } : {}) } as any);
      st.log.push({ who: 'ai', text: `Created ✓ — "${created.name}".`, at: new Date().toISOString() });
      st.plan = null; st.cost = null; st.seed = null; st.goal = null;
      await this.builderSave(st);
      return { ok: true as const, areaId: created.areaId, agentId: created.id, url: `/agent/a/${created.id}`, jobs: [{ id: created.id, name: created.name }] };
    }
    // ONE ROAD (BEA-1453). A spec created an agent switched ON, with no brief to read and no run to
    // watch — and a third model drew its flow half a minute later. That is how his first real agent
    // was made, and it is why he asked for the old road to go.
    if (st.spec) {
      throw new BadRequestException(
        'This conversation is from the older way of building agents, which made them without showing you anything first. Start a new one and I will write you a brief you can read, and run it once before you keep it.',
      );
    }
    throw new BadRequestException('There is no brief to open yet — keep chatting, and I will write one when I understand the job.');
  }

  /**
   * Create a WHOLE agent from a spec in one call (BEA-1103) — the landing point for the Claude
   * Code skill and the in-app chat builder: area (identity + tools) + its jobs (each with task,
   * outcome, schedule and per-job settings). Nothing partial: a bad spec is refused up front.
   */
  async createFromSpec(spec: any, goal?: string | null, folderId?: string | null): Promise<{ ok: true; areaId: string; url: string; jobs: { id: string; name: string }[] }> {
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
      ...(folderId ? { folderId } : {}), // created from inside a folder → it lands there (BEA-1380)
    });
    const jobs: { id: string; name: string }[] = [];
    for (const j of jobsIn.slice(0, 12)) {
      const created: any = await this.agentSvc.createAgent({
        areaId: area.id,
        name: j.name.trim(),
        icon: j.icon || areaIn.icon || undefined,
        color: j.color || areaIn.color || undefined,
        // The goal from the builder conversation rides onto each job (BEA-1378).
        description: withGoal(j.description, goal),
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
      folderId: area.folderId || null, // the flat folder this card sits in (BEA-1380); null = Unfiled
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

  async create(input: { name?: string; icon?: string; color?: string; description?: string; outcome?: string; tools?: AreaTool[]; sourceUrl?: string; folderId?: string | null }) {
    if (!input?.name?.trim()) throw new BadRequestException('An agent needs a name');
    const area = await (this.prisma as any).agentArea.create({
      data: {
        name: input.name.trim().slice(0, 120),
        icon: input.icon || null,
        color: input.color?.trim() || null,
        description: input.description?.trim() || null,
        tools: JSON.stringify(this.cleanTools(input.tools)),
        sourceUrl: input.sourceUrl?.trim() || null,
        // Created from inside a folder → it lands in that folder (BEA-1380). A folder that no
        // longer exists degrades to Unfiled rather than failing the create.
        folderId: input.folderId ? await this.folderIdOrNull(input.folderId) : null,
      },
    });
    return this.shape(area);
  }

  async update(id: string, patch: { name?: string; icon?: string; color?: string; description?: string; outcome?: string; tools?: AreaTool[]; sourceUrl?: string; folderId?: string | null }) {
    const data: any = {};
    if (patch.name !== undefined) data.name = patch.name.trim().slice(0, 120) || undefined;
    if (patch.icon !== undefined) data.icon = patch.icon || null;
    if (patch.color !== undefined) data.color = patch.color?.trim() || null;
    if (patch.description !== undefined) data.description = patch.description?.trim() || null;
    if (patch.tools !== undefined) data.tools = JSON.stringify(this.cleanTools(patch.tools));
    if ((patch as any).outcome !== undefined) data.outcome = ((patch as any).outcome || '').trim().slice(0, 2000) || null;
    if (patch.sourceUrl !== undefined) data.sourceUrl = patch.sourceUrl?.trim() || null;
    // Move to a folder (BEA-1380): null/'' = back to Unfiled; a real id must exist.
    if (patch.folderId !== undefined) {
      if (!patch.folderId) data.folderId = null;
      else {
        const f = await this.findFolder(patch.folderId);
        if (!f) throw new NotFoundException('That folder does not exist any more');
        data.folderId = f.id;
      }
    }
    const area = await (this.prisma as any).agentArea.update({ where: { id }, data }).catch(() => { throw new NotFoundException('Agent not found'); });
    return this.shape(area);
  }

  // ---- Folders (BEA-1380): flat, owner-made, each agent card in at most one -------------------

  private async findFolder(id: string): Promise<any | null> {
    return await Promise.resolve((this.prisma as any).agentFolder?.findUnique?.({ where: { id } })).catch(() => null) || null;
  }

  /** A folder id if that folder still exists, else null (Unfiled) — for creates, which must not fail on a stale folder. */
  private async folderIdOrNull(id?: string | null): Promise<string | null> {
    if (!id || typeof id !== 'string') return null;
    const f = await this.findFolder(id);
    return f ? f.id : null;
  }

  /** All folders in order, each with how many agent cards it holds — plus the Unfiled count. */
  async listFolders() {
    const [folders, areas] = await Promise.all([
      Promise.resolve((this.prisma as any).agentFolder?.findMany?.({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] })).catch(() => []),
      Promise.resolve((this.prisma as any).agentArea?.findMany?.({ select: { id: true, folderId: true } })).catch(() => []),
    ]);
    const counts = new Map<string, number>();
    let unfiled = 0;
    for (const a of (areas || []) as any[]) {
      if (a.folderId) counts.set(a.folderId, (counts.get(a.folderId) || 0) + 1);
      else unfiled += 1;
    }
    return {
      folders: ((folders || []) as any[]).map((f) => ({ id: f.id, name: f.name, order: f.order ?? 0, createdAt: f.createdAt, count: counts.get(f.id) || 0 })),
      all: ((areas || []) as any[]).length,
      unfiled,
    };
  }

  async createFolder(name?: string) {
    const n = (name || '').trim().slice(0, 60);
    if (!n) throw new BadRequestException('A folder needs a name');
    const existing: any[] = await Promise.resolve((this.prisma as any).agentFolder?.findMany?.({ select: { name: true, order: true } })).catch(() => []) || [];
    if (existing.some((f) => String(f.name).trim().toLowerCase() === n.toLowerCase())) throw new BadRequestException(`You already have a folder called "${n}"`);
    const order = existing.reduce((m, f) => Math.max(m, Number(f.order) || 0), 0) + 1;
    const f = await (this.prisma as any).agentFolder.create({ data: { name: n, order } });
    return { id: f.id, name: f.name, order: f.order ?? 0, createdAt: f.createdAt, count: 0 };
  }

  async updateFolder(id: string, patch: { name?: string; order?: number }) {
    const data: any = {};
    if (patch.name !== undefined) {
      const n = (patch.name || '').trim().slice(0, 60);
      if (!n) throw new BadRequestException('A folder needs a name');
      const existing: any[] = await Promise.resolve((this.prisma as any).agentFolder?.findMany?.({ select: { id: true, name: true } })).catch(() => []) || [];
      if (existing.some((f) => f.id !== id && String(f.name).trim().toLowerCase() === n.toLowerCase())) throw new BadRequestException(`You already have a folder called "${n}"`);
      data.name = n;
    }
    if (patch.order !== undefined && Number.isFinite(Number(patch.order))) data.order = Math.max(0, Math.floor(Number(patch.order)));
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to change');
    const f = await (this.prisma as any).agentFolder.update({ where: { id }, data }).catch(() => { throw new NotFoundException('Folder not found'); });
    return { id: f.id, name: f.name, order: f.order ?? 0, createdAt: f.createdAt };
  }

  /** Delete a folder. Its agents are NEVER deleted — they go back to Unfiled (BEA-1380). */
  async deleteFolder(id: string) {
    const f = await this.findFolder(id);
    if (!f) throw new NotFoundException('Folder not found');
    const unfiled = await (this.prisma as any).agentArea.updateMany({ where: { folderId: id }, data: { folderId: null } });
    try {
      await (this.prisma as any).agentFolder.delete({ where: { id } });
    } catch {
      // Swallow only "already gone" — a real failure must not report "deleted" while the row stays.
      if (await this.findFolder(id)) throw new BadRequestException('Could not delete the folder — try again');
    }
    return { ok: true, unfiled: unfiled?.count ?? 0 };
  }

  /** Bulk move: several agent cards into one folder (or back to Unfiled with folderId null). */
  async moveAreasToFolder(ids: string[], folderId?: string | null) {
    const clean = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x).slice(0, 200) : [];
    if (!clean.length) throw new BadRequestException('Pick at least one agent to move');
    let target: string | null = null;
    if (folderId) {
      const f = await this.findFolder(folderId);
      if (!f) throw new NotFoundException('That folder does not exist any more');
      target = f.id;
    }
    const res = await (this.prisma as any).agentArea.updateMany({ where: { id: { in: clean } }, data: { folderId: target } });
    return { ok: true, moved: res?.count ?? 0, folderId: target };
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
    // Its briefs go too (BEA-1405/1406). `AgentBrief` has no foreign key — same hand-kept rule as
    // `SocialWatch` and `RunJournal` — and each one holds a whole conversation, so leaving them
    // behind would pile up transcripts nothing can ever read again.
    await Promise.resolve((this.prisma as any).agentBrief?.deleteMany?.({ where: { areaId: id } })).catch(() => undefined);
    // And its trials (BEA-1408) — same hand-kept rule, and each one holds the rows and the message a
    // rehearsal produced.
    await Promise.resolve((this.prisma as any).agentTrial?.deleteMany?.({ where: { areaId: id } })).catch(() => undefined);
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
