import { Injectable, Logger } from '@nestjs/common';
import { HermesClient, HermesRunHandlers } from './hermes.client';
import { AgentService } from '../agent/agent.service';
import { DocumentsService } from '../documents/documents.service';
import { TelegramService } from '../telegram/telegram.service';
import { MemoryService } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';

const HUMAN_WAIT_MS = 20 * 60 * 1000; // how long a mid-run question stays open before the default is applied
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type StartRunInput = {
  prompt: string;
  title?: string;
  agentId?: string;
  saveCollectionId?: string | null;
  /** Save the final answer as a Document (default true). */
  save?: boolean;
};

/**
 * HermesBridgeService (BEA-618) — orchestrates one agent run on Hermes and mirrors it into our
 * shell: streams the engine's steps into the AgentRun (the run screen polls those), and saves the
 * result into Documents. Hermes is the doer; My Brain owns the record + the output.
 */
@Injectable()
export class HermesBridgeService {
  private readonly log = new Logger('HermesBridge');

  constructor(
    private readonly hermes: HermesClient,
    private readonly agent: AgentService,
    private readonly documents: DocumentsService,
    private readonly telegram: TelegramService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
  ) {}

  /** Recall-before: pull relevant context from the user's brain and prepend it to the task. */
  private async recall(runId: string, task: string): Promise<string> {
    try {
      const hits = await this.memory.searchBrain(task, 6);
      if (!hits?.length) return task;
      const ctx = hits.map((h) => `- ${h.title || 'note'}: ${(h.content || '').replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
      await this.agent.appendStep(runId, { label: `Recalled ${hits.length} note${hits.length > 1 ? 's' : ''} from your brain`, status: 'done' }).catch(() => undefined);
      return `Relevant context from the user's own second brain (use where helpful, ignore if not):\n${ctx}\n\n---\nTask: ${task}`;
    } catch {
      return task;
    }
  }

  /** Learn-after: propose a few durable facts from the result (the user keeps/forgets later). */
  private async proposeLearnings(runId: string, result: string): Promise<void> {
    try {
      const out = await this.llm.complete(
        `Read this agent result and list up to 3 SHORT durable facts worth remembering long-term — about the user, their projects, or useful knowledge they gathered. One per line, plain text, no bullets or numbering. If nothing is worth keeping, output nothing.\n\nResult:\n${result.slice(0, 2500)}`,
        200,
        'agent-learn',
      );
      const facts = (out || '').split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter((s) => s.length > 3).slice(0, 3);
      if (facts.length) {
        await this.agent.setLearnings(runId, facts.map((text) => ({ text, status: 'proposed' })));
        await this.agent.appendStep(runId, { label: `Noted ${facts.length} thing${facts.length > 1 ? 's' : ''} I learned`, status: 'done' }).catch(() => undefined);
      }
    } catch { /* learnings are best-effort */ }
  }

  /** Pause the run on a durable question, notify over Telegram, and wait for the answer (or the timeout default). */
  private async askHuman(runId: string, runTitle: string | undefined, q: { question: string; kind: string; options?: unknown; defaultValue?: string }, timeoutMs = HUMAN_WAIT_MS): Promise<string> {
    const wp = await this.agent.ask(runId, { question: q.question, kind: q.kind as any, options: q.options ?? [], defaultValue: q.defaultValue, expiresInMs: timeoutMs });
    await this.agent.appendStep(runId, { label: 'Asked you', status: 'awaiting', detail: q.question }).catch(() => undefined);
    await this.telegram.pushAgentQuestion({ runTitle, waitpointId: wp.id, question: q.question, kind: wp.kind, options: wp.options }).catch(() => undefined);
    // poll the durable waitpoint until it's answered (here or on Telegram) or the timeout sweeper applies the default
    for (let i = 0; i < timeoutMs / 2000 + 60; i++) {
      await sleep(2000);
      const cur = await this.agent.getWaitpoint(wp.resumeToken).catch(() => null);
      if (!cur) continue;
      if (cur.status === 'answered') { await this.agent.appendStep(runId, { label: 'You answered', status: 'done', detail: String(cur.answer) }).catch(() => undefined); return String(cur.answer ?? q.defaultValue ?? 'proceed'); }
      if (cur.status === 'expired' || cur.status === 'cancelled') break;
    }
    return q.defaultValue ?? 'proceed';
  }

  /** Create the run row and kick off execution in the background; returns immediately. */
  async startRun(input: StartRunInput) {
    const run = await this.agent.createRun({ agentId: input.agentId ?? null, title: input.title || 'Agent run', input: input.prompt });
    // fire-and-forget — the run screen polls GET /api/agent/runs/:id for live progress
    this.execute(run.id, input).catch((e) => this.log.error(`run ${run.id} crashed: ${e?.message || e}`));
    return run;
  }

  /** Synchronous variant (used by tests / callers that want to await the whole run). */
  async execute(runId: string, input: StartRunInput) {
    await this.agent.appendStep(runId, { label: 'Starting up', status: 'done' });
    const cfg = await this.agent.engineSettings();
    const timeoutMs = cfg.askTimeoutMin * 60_000;
    const prompt = cfg.recall ? await this.recall(runId, input.prompt) : input.prompt;

    const handlers: HermesRunHandlers = {
      onStep: (s) => void this.agent.appendStep(runId, s).catch(() => undefined),
      // BEA-620: the agent pauses and asks YOU (durable waitpoint + Telegram), then resumes —
      // gated by the autonomy setting.
      onApproval: async (a) => {
        if (cfg.autonomy === 'autopilot') {
          await this.agent.appendStep(runId, { label: 'Skipped a risky action (autopilot)', status: 'info', detail: a.command }).catch(() => undefined);
          return 'deny'; // never auto-run risky things, even on autopilot
        }
        const ans = await this.askHuman(runId, input.title, {
          question: `Allow this action?\n${a.command || a.description || 'a tool action'}`,
          kind: 'approve_edit_reject',
          options: { command: a.command, description: a.description },
          defaultValue: 'reject',
        }, timeoutMs);
        return ans === 'approve' ? 'once' : 'deny';
      },
      onClarify: async (q) => {
        const choices = q.choices && q.choices.length ? q.choices : undefined;
        const fallback = choices ? choices[0] : 'Use your best judgment and proceed.';
        if (cfg.autonomy !== 'cautious') {
          // balanced + autopilot proceed with the best guess rather than stopping to ask
          await this.agent.appendStep(runId, { label: 'Decided without asking', status: 'info', detail: q.question }).catch(() => undefined);
          return fallback;
        }
        return this.askHuman(runId, input.title, {
          question: q.question,
          kind: choices ? 'choice' : 'free_text',
          options: choices || [],
          defaultValue: fallback,
        }, timeoutMs);
      },
    };

    let result;
    try {
      result = await this.hermes.runTurn(prompt, handlers, { title: input.title, model: cfg.model || undefined });
    } catch (e: any) {
      await this.agent.finishRun(runId, { status: 'failed', error: friendlyError(e?.message) });
      return;
    }

    if (result.status === 'error') {
      await this.agent.finishRun(runId, { status: 'failed', error: friendlyError(result.error) });
      return;
    }

    const text = (result.finalText || '').trim();
    if (text && cfg.learn) await this.proposeLearnings(runId, text);
    if (input.save !== false && text) {
      try {
        const doc = await this.documents.create({
          title: input.title || 'Agent result',
          contentText: text,
          kind: 'md',
          collectionId: input.saveCollectionId ?? cfg.outputCollectionId ?? null,
          tags: ['agent'],
        });
        await this.agent.attachOutput(runId, doc.id);
        await this.agent.appendStep(runId, { label: 'Saved to Documents', status: 'done', detail: doc.title });
        await this.agent.finishRun(runId, { status: 'done', outputDocId: doc.id });
        return;
      } catch (e: any) {
        await this.agent.appendStep(runId, { label: 'Could not save the document', status: 'failed', detail: e?.message }).catch(() => undefined);
      }
    }
    await this.agent.finishRun(runId, { status: 'done' });
  }
}

function friendlyError(msg?: string): string {
  if (!msg) return 'The agent engine hit a problem.';
  if (/timed out/i.test(msg)) return 'The agent took too long and was stopped.';
  if (/login|ws-ticket|unreachable|ECONN|fetch failed/i.test(msg)) return 'Could not reach the agent engine (Hermes). Is it running?';
  return msg;
}
