import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';
import { BriefService } from '../agent/brief.service';
import { briefToAgentInput } from '../agent/brief';
import { WorkerBuildService } from './worker-build.service';
import { WorkerDispatchService } from './worker-dispatch.service';
import { TrialService, TrialView, whyNotCreatable } from './trial.service';
import { OwnerAskService } from './owner-ask.service';
import { AgentService as _Agent } from '../agent/agent.service';

/** The two things he may say back. Anything else is treated as "send it back". */
export const KEEP_IT = 'Keep it';
export const SEND_BACK = 'Send it back';

/**
 * Did he say yes? Deliberately narrow: only a clear yes keeps an agent. Anything else — including
 * silence, a question, or a sentence about what was wrong — sends it back. Keeping something he did
 * not clearly ask to keep is the one mistake this whole design exists to prevent.
 */
export function saidKeepIt(answer: string): boolean {
  const t = String(answer || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t) return false;
  return /^(keep it|keep|yes|yeah|yep|ya|ok|okay|good|perfect|create it|create|1)$/.test(t);
}

/**
 * From an approved brief to a run he can look at (BEA-1408, "Brief First").
 *
 * The order matters, and every step of it exists because of something that went wrong:
 *
 *  1. **The brief must be approved.** The four rules already refused a brief with a hole in it.
 *  2. **A draft job**, created switched OFF. It carries the sources so the kit can fetch them, and
 *     nothing else. It never fires on a schedule, because `enabled:false`.
 *  3. **Codex builds the worker** from the brief and the whole conversation (BEA-1407).
 *  4. **The worker runs once, for real, in TRIAL mode** — writing nothing, sending nothing.
 *  5. He looks at the real rows and the real message. Only then is Create possible.
 *
 * Nothing here converts anything automatically. A trial is a rehearsal; Create is his tap.
 */
@Injectable()
export class BriefTrialService {
  private readonly log = new Logger('BriefTrial');
  /** Trials in flight, by area — a second tap must not start a second build. */
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly briefs: BriefService,
    private readonly trials: TrialService,
    private readonly agent: AgentService,
    private readonly builds: WorkerBuildService,
    private readonly dispatch: WorkerDispatchService,
    // Optional + LAST — spec harnesses build this positionally with fewer args.
    private readonly owner?: OwnerAskService,
  ) {}

  onModuleInit() {
    // Hear his answer whichever road it came down — WhatsApp, the run screen, Telegram (BEA-1418).
    this.owner?.setAnswerWatcher?.((runId, answer) => this.onAnswer(runId, answer));
  }

  /**
   * He answered a "keep it or send it back" question. Only a clear yes keeps it; everything else is
   * his sentence about what was wrong, and goes back into the conversation as his words.
   *
   * `create()` still decides — WhatsApp is another way to press the button, never a way around it.
   */
  private async onAnswer(runId: string, answer: string): Promise<void> {
    const trial = await this.prisma?.agentTrial?.findFirst?.({ where: { runId: String(runId) }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    if (!trial) return;
    const areaId = String(trial.areaId);
    try {
      if (saidKeepIt(answer)) {
        const out = await this.create(areaId);
        await this.agent.appendStep(runId, {
          label: out.ok ? 'You kept it. It is yours now.' : `Not kept — ${out.whyNot}`,
          status: out.ok ? 'done' : 'info',
          kind: 'ask',
        }).catch(() => undefined);
      } else {
        await this.sendBack(areaId, answer);
        await this.agent.appendStep(runId, { label: `Sent back: ${String(answer).slice(0, 160)}`, status: 'done', kind: 'ask' }).catch(() => undefined);
      }
    } catch (e: any) {
      this.log.warn(`could not act on his answer for trial ${trial.id}: ${e?.message || e}`);
    } finally {
      await this.agent.finishRun(runId, { status: 'done' }).catch(() => undefined);
    }
  }

  // ---- what the screen asks for --------------------------------------------------------------------

  /** The trial for the brief he is looking at now, and whether Create is possible yet. */
  async state(areaId: string): Promise<{ trial: TrialView | null; canCreate: boolean; whyNot: string; running: boolean }> {
    const brief = await this.briefs.latest(areaId);
    if (!brief) return { trial: null, canCreate: false, whyNot: 'There is no brief yet.', running: false };
    const trial = await this.trials.latest(areaId, brief.version);
    const whyNot = whyNotCreatable(brief, trial);
    return { trial, canCreate: !whyNot, whyNot, running: this.running.has(areaId) || trial?.status === 'building' || trial?.status === 'running' };
  }

  // ---- the trial ------------------------------------------------------------------------------------

  /**
   * Start one. Answers as soon as the row exists — a build turn is a real Codex session and takes
   * minutes, so the screen polls rather than holding a request open for them.
   */
  async start(areaId: string): Promise<TrialView> {
    const brief = await this.briefs.approved(areaId);
    if (!brief) throw new BadRequestException('Approve the brief first — then you can watch it run once.');
    if (this.running.has(areaId)) throw new BadRequestException('It is already running. Give it a moment.');

    const trial = await this.trials.start({ areaId, briefId: brief.id, briefVersion: brief.version });
    this.running.add(areaId);
    // Deliberately not awaited: the screen polls `state()`. A crash in here settles the row as
    // failed with a readable reason, so a trial can never sit at "building" for ever.
    this.work(areaId, trial).finally(() => this.running.delete(areaId));
    return trial;
  }

  private async work(areaId: string, trial: TrialView): Promise<void> {
    let agentId = '';
    try {
      const brief = await this.briefs.approved(areaId);
      if (!brief) throw new Error('The brief is no longer approved.');
      if (!brief.sources?.length) throw new Error('Nothing is set up to fetch anything yet.');

      const job = await this.draftJob(areaId, brief);
      agentId = job.id;
      await this.prisma.agentTrial.update({ where: { id: trial.id }, data: { agentId } }).catch(() => undefined);

      // 3. Build — unless a promoted worker for exactly this brief is already installed.
      const before = await this.builds.state(agentId);
      if (!before.worker || before.stale) {
        const built = await this.builds.build(agentId, { reason: `trial of brief v${brief.version}` });
        if (!built.worker || built.stale) {
          throw new Error(built.built?.why || 'The program could not be built from this brief. Nothing has changed.');
        }
      }

      // 4. Run it once, for real, holding everything back.
      const run = await this.agent.createRun({ agentId, title: `Trial — ${brief.name || 'this agent'}` });
      await this.trials.attach(trial.id, run.id);
      const out = await this.dispatch.run(run.id, agentId, { trial: true });
      if (out.fallback) throw new Error(out.fallback);

      const finished = await this.prisma.agentRun.findUnique({ where: { id: run.id } }).catch(() => null);
      const ok = String(finished?.status || '') === 'done';
      await this.trials.settle(run.id, {
        ok,
        verdict: ok ? this.verdictOf(brief) : '',
        error: ok ? '' : String(finished?.error || 'It stopped without saying why.'),
        credits: await this.creditsOf(run.id),
        aiTokens: Number((finished as any)?.aiTokens) || 0,
      });
      if (ok) await this.askHim(run.id, brief).catch((e: any) => this.log.warn(`could not ask him on WhatsApp: ${e?.message || e}`));
    } catch (e: any) {
      this.log.warn(`trial ${trial.id} failed: ${e?.message || e}`);
      await this.trials.fail(trial.id, String(e?.message || e));
    }
  }

  /**
   * Send him the result and wait — for days, if that is how long he takes (BEA-1418).
   *
   * A build turn plus a trial takes minutes, and some agents will take much longer. Sitting on a
   * screen waiting is not how he works; his phone is. What goes out is the message the agent would
   * have sent him, one line of context, and a link — never the rows, because a 47-row table is not
   * going to a phone.
   *
   * **If he never answers, nothing happens.** No default, no timeout that keeps an agent he never
   * asked to keep.
   */
  private async askHim(runId: string, brief: any): Promise<void> {
    const trial = await this.trials.latest(String(brief.areaId), Number(brief.version));
    if (!trial || trial.status !== 'passed') return;
    const reopened = await this.agent.reopenForDecision(runId, 'Waiting for you to say whether to keep it.');
    if (!reopened) return;

    // WHAT HAPPENED, IN THE WORKER'S OWN WORDS (BEA-1463).
    //
    // This line used to be assembled here from counters the app keeps, and it was wrong on the
    // owner's first real trial: it read *"It 1 row, cost nothing"* — no verb, and "1 row" for a run
    // that had read fourteen emails and kept two. Both halves were the app talking about a program
    // it does not understand. The program had already said it perfectly — `resultText` on its own
    // run was "2 important emails summarised" — and nobody asked it.
    //
    // So the program's sentence is the sentence. The app adds only the two things it alone knows:
    // that nothing was saved or sent, and how to answer.
    const run: any = await this.agent.getRun?.(runId).catch(() => null);
    const said = String(run?.resultText || '').trim();
    const cost = trial.credits > 0 ? ` It cost ${trial.credits} credit${trial.credits === 1 ? '' : 's'}.` : '';
    const question = [
      said
        ? `"${brief.name || 'Your new agent'}" ran once: ${said}.${cost} Nothing was saved and nothing was sent.`
        : `"${brief.name || 'Your new agent'}" ran once.${cost} Nothing was saved and nothing was sent.`,
      trial.message ? `\nThis is what it would send you:\n\n${trial.message}` : '',
      '\nKeep it? Reply "keep it", or tell me what was wrong.',
    ].filter(Boolean).join('\n');

    const wp: any = await this.agent.ask(runId, {
      question,
      kind: 'choice',
      options: [KEEP_IT, SEND_BACK],
      // No default and no expiry ON PURPOSE. A timeout that keeps an agent he never approved would
      // walk straight past the gate this whole design is.
      askedVia: 'whatsapp',
    });
    await Promise.resolve(
      this.owner?.send?.(runId, String(wp?.id || ''), { jobName: String(brief.name || 'Your new agent'), question, choices: [KEEP_IT, SEND_BACK] }),
    ).catch((e: any) => this.log.warn(`the message did not go out: ${e?.message || e}`));
  }

  /** His own "what it worked means" sentence, read back to him beside the result. */
  private verdictOf(brief: { sections: any }): string {
    const lines = (brief.sections?.success || []).filter((l: any) => !l.struck).map((l: any) => l.text);
    return lines.length ? `It met what you asked for: ${lines.join(' ')}` : 'It finished.';
  }

  private async creditsOf(runId: string): Promise<number> {
    const rows = (await this.prisma?.toolCall?.findMany?.({ where: { runId }, select: { credits: true } }).catch(() => [])) || [];
    return rows.reduce((n: number, r: any) => n + (Number(r.credits) || 0), 0);
  }

  /**
   * The job a trial runs on. ONE per agent: a second trial re-uses it and updates its sources, so
   * repeated runs do not litter his Agents page with drafts he never asked for.
   */
  private async draftJob(areaId: string, brief: any): Promise<{ id: string }> {
    const input = briefToAgentInput(brief);
    const existing = await this.prisma.agent.findFirst({ where: { areaId, origin: 'brief' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    if (existing) {
      await this.agent.updateAgent(existing.id, { ...input, areaId } as any).catch(() => undefined);
      return { id: String(existing.id) };
    }
    const made = await this.agent.createAgent({ ...input, areaId } as any);
    return { id: String((made as any).id) };
  }

  // ---- keeping it -------------------------------------------------------------------------------------

  /**
   * Create it for real. Refused unless a passing trial of THIS version of the brief exists — the
   * whole point of the gate, and the one rule that makes a wrong agent unable to reach him.
   */
  async create(areaId: string): Promise<{ ok: boolean; agentId?: string; whyNot?: string }> {
    const brief = await this.briefs.latest(areaId);
    if (!brief) return { ok: false, whyNot: 'There is no brief yet.' };
    const trial = await this.trials.latest(areaId, brief.version);
    const whyNot = whyNotCreatable(brief, trial);
    if (whyNot) return { ok: false, whyNot };
    const agentId = trial!.agentId!;
    await this.agent.updateAgent(agentId, { enabled: true } as any);
    return { ok: true, agentId };
  }

  /** "Send it back" — his sentence joins the conversation, and the brief goes back to a draft. */
  async sendBack(areaId: string, note: string): Promise<{ ok: boolean }> {
    const brief = await this.briefs.latest(areaId);
    if (!brief) throw new BadRequestException('There is no brief yet.');
    const said = String(note || '').trim();
    if (!said) throw new BadRequestException('Say what was wrong with it, in one line.');
    await this.briefs.addTurns(brief.id, [{ who: 'you', text: said }]);
    // Adding to an approved brief already starts the next version, which invalidates the trial —
    // so what he saw can never be mistaken for what would run next.
    await this.briefs.addLine(brief.id, 'want', said, 'owner');
    return { ok: true };
  }
}
