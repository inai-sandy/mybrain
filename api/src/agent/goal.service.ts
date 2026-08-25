import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { ToolKnowledgeService } from '../tools/tool-knowledge.service';
import { ToolSampleService } from '../tools/tool-sample.service';
import { cardText } from './thinking-builder';
import { GoalRequest, Turn, ToolInfo, goalPrompt, isQuestion, nothingCameBack } from './goal';

/** How much of Codex's answer is kept. A goal he has to scroll for ever is not a goal he reads. */
const GOAL_MAX = 20_000;

/** The most tokens the goal turn may spend. Generous — it is one turn, once, and it decides everything. */
const GOAL_TOKENS = 8000;

export type GoalView = {
  id: string;
  version: number;
  status: string;
  /** Codex's own text, exactly as written. Never re-shaped here. */
  text: string;
  /** Set when Codex replied with a question instead of a goal — it needs him before it can write one. */
  question?: string | null;
  note?: string | null;
  tools: string[];
  approvedAt?: string | null;
  updatedAt?: string | null;
  /**
   * What happened AFTER he approved (BEA-1467) — building | ran | failed, and why.
   *
   * This existed nowhere, and the cost was an hour of his life: he approved a goal, Codex built the
   * program, it ran, and it failed with a perfectly clear sentence ("I could not find a Gmail
   * action…") — and the screen showed "Codex is building it" for the whole hour, because that text
   * was static and nothing ever told it otherwise. A quiet failure, in the week I spent removing
   * quiet failures.
   */
  run?: { status: string; error?: string | null; resultText?: string | null; agentId?: string | null; runId?: string | null; at?: string | null } | null;
};

/**
 * THE GOAL (BEA-1463) — Codex says what it is going to build, and the owner approves it.
 *
 * His design, 2026-08-25: *"We should ask codex to create a goal and send it for approval. when i
 * approve the goal it has to create an agent and run a sample task to match the goal. verify the
 * goal and the output."*
 *
 * This replaces `BriefService`, and the difference that matters is the AUTHOR. A brief was the app's
 * structured reading of a conversation; this is Codex's. Nothing in this file writes a goal, edits
 * one, scores one or summarises one — it carries the conversation over, stores what comes back, and
 * shows it to him.
 *
 * Two rules it keeps:
 *  - **only an approved goal may be built from.** `approved()` is the one door, and a goal he sent
 *    back or never saw is not one;
 *  - **a question is not a goal.** When Codex answers with a question, the goal stays unwritten and
 *    the question goes to him — because guessing is what produced every defect this design replaces.
 */
@Injectable()
export class GoalService {
  private readonly log = new Logger('Goal');

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    // Optional + LAST — spec harnesses build this positionally with fewer arguments.
    private readonly knowledge?: ToolKnowledgeService,
    private readonly samples?: ToolSampleService,
  ) {}

  /** The newest goal for this conversation, whatever its state. Null when he has not asked yet. */
  async latest(areaId: string): Promise<GoalView | null> {
    const row = await this.prisma?.agentGoal?.findFirst?.({
      where: { areaId: String(areaId) },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });
    if (!row) return null;
    const view = this.view(row);
    if (row.status === 'approved') view.run = await this.runFor(String(areaId));
    return view;
  }

  /**
   * What became of it (BEA-1467): the newest run of the job this goal built.
   *
   * Read rather than stored, so it cannot go stale and there is no second place for the truth to
   * live. `building` is the honest answer for "approved, but nothing has run yet" — which covers
   * both a Codex turn still going and a build that died before it made a run.
   */
  private async runFor(areaId: string): Promise<GoalView['run']> {
    // Find it by the AREA, not by `origin`. Origin is a label, and relying on it stranded his very
    // first goal: the job was created before 'goal' was an accepted origin, so it was silently
    // stored as 'chat' and this lookup missed it — leaving the screen saying "building" for ever
    // about a run that had already failed. The area is the thing that is actually true.
    const job = await this.prisma?.agent?.findFirst?.({ where: { areaId }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    if (!job) return { status: 'building' };
    const run: any = await this.prisma?.agentRun?.findFirst?.({ where: { agentId: job.id }, orderBy: { startedAt: 'desc' } }).catch(() => null);
    if (!run) return { status: 'building', agentId: String(job.id) };
    return {
      status: String(run.status || ''),
      error: run.error ? String(run.error) : null,
      resultText: run.resultText ? String(run.resultText) : null,
      agentId: String(job.id),
      runId: String(run.id),
      at: run.startedAt ? new Date(run.startedAt).toISOString() : null,
    };
  }

  /** The approved goal — the ONE thing a build may stand on. */
  async approved(areaId: string): Promise<GoalView | null> {
    const row = await this.prisma?.agentGoal?.findFirst?.({
      where: { areaId: String(areaId), status: 'approved' },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });
    return row ? this.view(row) : null;
  }

  /**
   * He said "ok". Send Codex the conversation and the tools he named, and ask for the goal.
   *
   * Everything about this is deliberately thin: the transcript goes over whole, only the actions he
   * named go with it, and what comes back is stored as written. The app's one judgement is whether
   * the answer is a goal or a question, and that is a routing decision rather than a reading.
   */
  async propose(areaId: string, opts: { transcript: Turn[]; tools: string[] }): Promise<GoalView> {
    const turns = (opts.transcript || []).filter((t) => String(t?.text || '').trim());
    if (!turns.length) throw new BadRequestException('There is no conversation yet to build a goal from.');

    // A goal he sent back is the most direct information there is about what he wants, so it rides
    // into the next attempt in his own words.
    const last = await this.latest(areaId);
    const sentBack = last && last.status === 'sent_back' && last.note ? { text: last.text, note: last.note } : null;

    const req: GoalRequest = { transcript: turns, tools: await this.toolInfo(opts.tools || []), sentBack };
    const reply = await this.llm
      .completeHelper('agent-goal' as any, goalPrompt(req), GOAL_TOKENS, 'agent-goal')
      .catch((e: any) => {
        throw new BadRequestException(`Codex could not be reached to write the goal (${String(e?.message || e).slice(0, 160)}). Nothing has been built.`);
      });

    const empty = nothingCameBack(String(reply || ''));
    if (empty) throw new BadRequestException(empty);

    const text = String(reply).trim().slice(0, GOAL_MAX);
    const asks = isQuestion(text);
    const version = (last?.version || 0) + 1;

    const row = await this.prisma.agentGoal.create({
      data: {
        areaId: String(areaId),
        version,
        // A question leaves the goal UNWRITTEN. It is not a draft he can approve — there is nothing
        // to approve yet, and showing it as one would invite him to approve a question mark.
        status: asks ? 'asking' : 'proposed',
        text: asks ? '' : text,
        note: asks ? text : null,
        tools: JSON.stringify(opts.tools || []),
        transcript: JSON.stringify(turns),
      },
    });
    this.log.log(`goal v${version} for ${areaId}: ${asks ? 'Codex asked him something' : `${text.length} chars`}`);
    return this.view(row);
  }

  /** He answered a question Codex asked. It goes back in as another turn, and Codex tries again. */
  async answer(areaId: string, said: string): Promise<GoalView> {
    const last = await this.latest(areaId);
    if (!last || last.status !== 'asking') throw new BadRequestException('Nothing is waiting on an answer.');
    const turns: Turn[] = this.turnsOf(last);
    // The question is on `question` for an `asking` goal and on `note` for a sent-back one — one
    // column, two meanings, told apart by the status (see `view()`). Reading only `note` here dropped
    // Codex's question on the floor, so the retry saw his answer with nothing to answer.
    turns.push({ who: 'assistant', text: String(last.question || last.note || '') });
    turns.push({ who: 'you', text: String(said || '').trim() });
    return this.propose(areaId, { transcript: turns, tools: last.tools });
  }

  /**
   * What runs the moment he approves (BEA-1465) — registered at boot by `GoalTrialService`.
   *
   * A seam rather than an import: WorkerModule already imports AgentModule, so AgentModule cannot
   * import back. Same pattern as `setFlowSync` and `setWorkerDispatch`.
   */
  private onApproved: ((areaId: string) => any) | null = null;
  setOnApproved(fn: (areaId: string) => any) { this.onApproved = fn; }

  /** He approved it. This is the only thing that lets a build happen. */
  async approve(areaId: string): Promise<GoalView> {
    const last = await this.latest(areaId);
    if (!last) throw new BadRequestException('There is no goal to approve yet.');
    if (last.status === 'asking') throw new BadRequestException('Codex asked you something first — answer that, and it will write the goal.');
    if (!String(last.text || '').trim()) throw new BadRequestException('That goal is empty, so there is nothing to approve.');
    const row = await this.prisma.agentGoal.update({
      where: { id: last.id },
      data: { status: 'approved', approvedAt: new Date() },
    });
    // His instruction: *"when i approve the goal it has to create an agent and run a sample task to
    // match the goal."* Approving is the trigger, not a bookmark. Deliberately not awaited — a real
    // Codex build takes minutes and the screen polls — and deliberately never able to fail the
    // approval itself: the goal IS approved whatever happens next.
    try { void Promise.resolve(this.onApproved?.(String(areaId))).catch(() => undefined); } catch { /* the approval stands */ }
    return this.view(row);
  }

  /** He sent it back with a correction. Codex writes it again, having read what he said. */
  async sendBack(areaId: string, note: string): Promise<GoalView> {
    const last = await this.latest(areaId);
    if (!last) throw new BadRequestException('There is no goal to send back.');
    const said = String(note || '').trim();
    if (!said) throw new BadRequestException('Say what was wrong with it — that sentence is what Codex reads.');
    await this.prisma.agentGoal.update({ where: { id: last.id }, data: { status: 'sent_back', note: said } });
    return this.propose(areaId, { transcript: this.turnsOf(last), tools: last.tools });
  }

  // ---- the tools he named ------------------------------------------------------------------------

  /**
   * What Codex is told about each action he named: the catalog's own fact card, and a real saved
   * answer where one was kept.
   *
   * Nothing is added beyond what he named — he was explicit about that: *"Why do you have to send
   * the full catalog of tools? During the chat discussion I will let you know the tools that we have
   * to send."* An action we know nothing about still goes over, saying so.
   */
  private async toolInfo(ids: string[]): Promise<ToolInfo[]> {
    const out: ToolInfo[] = [];
    for (const raw of ids || []) {
      const actionId = String(raw || '').trim();
      if (!actionId) continue;
      const card = await this.knowledge?.card?.(actionId).catch(() => null);
      let sample: any = undefined;
      try { sample = (await this.samples?.replay?.(actionId))?.data ?? undefined; } catch { sample = undefined; }
      out.push({ actionId, name: (card as any)?.name || null, card: card ? cardText(card as any) : null, sample });
    }
    return out;
  }

  private turnsOf(v: GoalView | any): Turn[] {
    try {
      const raw = typeof v.transcript === 'string' ? JSON.parse(v.transcript) : v.transcript;
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private view(row: any): GoalView {
    let tools: string[] = [];
    try { const t = JSON.parse(row.tools || '[]'); tools = Array.isArray(t) ? t.map(String) : []; } catch { tools = []; }
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      text: String(row.text || ''),
      // The question rides on `note` when Codex asked rather than answered — one column, two
      // meanings, told apart by the status. `sent_back` puts HIS words there instead.
      question: row.status === 'asking' ? String(row.note || '') : null,
      note: row.status === 'sent_back' ? String(row.note || '') : null,
      tools,
      approvedAt: row.approvedAt ? new Date(row.approvedAt).toISOString() : null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      ...(row.transcript ? { transcript: row.transcript } : {}),
    } as GoalView;
  }
}
