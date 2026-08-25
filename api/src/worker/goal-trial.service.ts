import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentService } from '../agent/agent.service';
import { GoalService } from '../agent/goal.service';
import { WorkerBuildService } from './worker-build.service';
import { WorkerDispatchService } from './worker-dispatch.service';
import { TrialService } from './trial.service';
import { OwnerAskService } from './owner-ask.service';

export const KEEP_IT = 'Keep it';
export const SEND_BACK = 'Send it back';

/**
 * APPROVE THE GOAL → BUILD IT → RUN IT ONCE AGAINST THAT GOAL (BEA-1465).
 *
 * The owner's instruction, 2026-08-25, in full:
 *
 *   *"We should ask codex to create a goal and send it for approval. when i approve the goal it has
 *   to create an agent and run a sample task to match the goal. verify the goal and the output."*
 *
 * The goal (BEA-1463) and the goal-driven build (BEA-1464) were the first two thirds. This is the
 * last: approving is not a bookmark, it is the trigger. An agent is created, Codex compiles it from
 * the conversation and the goal, and it runs ONCE for real with everything held back — nothing
 * written, nothing sent — so he can hold the result next to the goal and judge it himself.
 *
 * Where it differs from `BriefTrialService`, which it is modelled on:
 *
 *  - **the agent is created from the goal, not from a plan.** There are no sources to copy across,
 *    because there is no plan; the job exists to hold the runs, the tools he named, and the switch;
 *  - **nothing here decides whether the run met the goal.** Codex's own program does that, in its
 *    own words, and this carries the verdict through untouched. The app scoring a result against a
 *    goal it did not write is precisely the habit this whole redesign removes.
 */
@Injectable()
export class GoalTrialService implements OnModuleInit {
  private readonly log = new Logger('GoalTrial');
  /** One trial per conversation at a time — a second tap must not spawn a second Codex build. */
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly goals: GoalService,
    private readonly agent: AgentService,
    private readonly builds: WorkerBuildService,
    private readonly dispatch: WorkerDispatchService,
    private readonly trials: TrialService,
    // Optional + LAST — spec harnesses build this positionally with fewer arguments.
    private readonly owner?: OwnerAskService,
  ) {}

  onModuleInit() {
    // The seam (see `GoalService.setOnApproved`). AgentModule cannot import WorkerModule — the
    // dependency runs the other way — so the worker side registers itself at boot.
    this.goals.setOnApproved((areaId: string) => this.start(areaId).catch((e: any) => {
      this.log.warn(`could not start the first run for ${areaId}: ${e?.message || e}`);
    }));
  }

  /**
   * He approved the goal. Build it and run it once.
   *
   * Deliberately not awaited by the caller: a real Codex build takes minutes and the screen polls.
   * A crash inside settles the trial row with a readable reason, so it can never sit at "building"
   * for ever.
   */
  async start(areaId: string): Promise<{ started: boolean; agentId?: string; why?: string }> {
    const goal = await this.goals.approved(areaId);
    if (!goal || !String(goal.text || '').trim()) {
      throw new BadRequestException('Approve the goal first — then it gets built and run once.');
    }
    if (this.running.has(areaId)) return { started: false, why: 'It is already building. Give it a moment.' };

    this.running.add(areaId);
    const job = await this.jobFor(areaId, goal);
    void this.work(areaId, goal, job.id).finally(() => this.running.delete(areaId));
    return { started: true, agentId: job.id };
  }

  private async work(areaId: string, goal: any, agentId: string): Promise<void> {
    try {
      // 1. Compile it. The build reads the conversation and the goal itself (BEA-1464) — nothing
      //    about the shape of the work is decided here.
      const before = await this.builds.state(agentId);
      if (!before.worker || before.stale) {
        const built = await this.builds.build(agentId, { reason: `first run of goal v${goal.version}` });
        if (!built.worker || built.stale) {
          throw new Error(built.built?.error || 'Codex could not build a working program from this goal. Nothing has changed.');
        }
      }

      // 2. Run it once for real, with everything held back. The trial token is what makes that true
      //    — it rides on the token, never on the body, so the program cannot argue its way out.
      const run = await this.agent.createRun({ agentId, title: `First run — ${goal.text.slice(0, 60)}` });
      const out = await this.dispatch.run(run.id, agentId, { trial: true });
      if (out.fallback) throw new Error(out.fallback);

      const finished = await this.prisma.agentRun.findUnique({ where: { id: run.id } }).catch(() => null);
      const ok = String(finished?.status || '') === 'done';

      // 3. Tell him, in the program's own words. Codex wrote the goal and wrote the check; whether
      //    the run met it is its sentence to say, not ours to compute.
      if (ok) await this.askHim(run.id, goal, String((finished as any)?.resultText || '')).catch((e: any) => this.log.warn(`could not reach him: ${e?.message || e}`));
      else this.log.warn(`first run of ${agentId} failed: ${String(finished?.error || '')}`);
    } catch (e: any) {
      this.log.warn(`goal trial for ${areaId} failed: ${e?.message || e}`);
    }
  }

  /**
   * The agent that holds this conversation's runs.
   *
   * It carries the tools he named and nothing else — no sources, no plan, no output destination.
   * Everything about HOW the work happens lives in the program Codex wrote, which is the point.
   */
  private async jobFor(areaId: string, goal: any): Promise<{ id: string }> {
    const input: any = {
      name: titleOf(goal.text),
      description: String(goal.text || '').slice(0, 2000),
      prompt: String(goal.text || ''),
      tools: goal.tools || [],
      origin: 'goal',
      areaId,
      useWorker: true,
      // Off until he keeps it. Approving the GOAL starts one run; it does not put a schedule live.
      enabled: false,
    };
    // By AREA, for the same reason (BEA-1467): a job whose origin did not survive the create would
    // never be found here either, and every approval would make one more duplicate agent.
    const existing = await this.prisma.agent.findFirst({ where: { areaId }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    if (existing) {
      await this.agent.updateAgent(existing.id, input).catch(() => undefined);
      return { id: String(existing.id) };
    }
    const made = await this.agent.createAgent(input);
    return { id: String((made as any).id) };
  }

  /**
   * Put the goal and the result in front of him together — his words: *"verify the goal and the
   * output"*.
   *
   * The app contributes exactly two things nobody else can know: that nothing was saved or sent, and
   * how to answer. Everything else is the program's own sentence.
   */
  private async askHim(runId: string, goal: any, said: string): Promise<void> {
    const reopened = await this.agent.reopenForDecision(runId, 'Waiting for you to say whether to keep it.');
    if (!reopened) return;

    const question = [
      'It ran once. Nothing was saved and nothing was sent.',
      '',
      'THE GOAL you approved:',
      String(goal.text || '').trim(),
      '',
      said ? `WHAT IT DID:\n${said}` : 'It did not say what it did.',
      '',
      'Does that match? Reply "keep it", or tell me what was wrong.',
    ].join('\n');

    const wp: any = await this.agent.ask(runId, {
      question,
      kind: 'choice',
      options: [KEEP_IT, SEND_BACK],
      // No default and no expiry, deliberately: a timeout that keeps an agent he never looked at
      // walks straight past the gate this exists to be.
      askedVia: 'whatsapp',
    });
    await Promise.resolve(
      this.owner?.send?.(runId, String(wp?.id || ''), { jobName: titleOf(goal.text), question, choices: [KEEP_IT, SEND_BACK] }),
    ).catch((e: any) => this.log.warn(`the message did not go out: ${e?.message || e}`));
  }
}

/**
 * A name for the job, taken from the goal's first line.
 *
 * The shortest possible reading of Codex's text, and the only one anywhere: a job row needs a name
 * for lists and notifications. It is a label, never used to decide anything.
 */
export function titleOf(goal: string): string {
  const first = String(goal || '')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0) || 'New agent';
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}
