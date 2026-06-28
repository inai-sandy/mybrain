import { Injectable, Logger } from '@nestjs/common';
import { HermesClient, HermesRunHandlers } from './hermes.client';
import { AgentService } from '../agent/agent.service';
import { DocumentsService } from '../documents/documents.service';

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
  ) {}

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

    const handlers: HermesRunHandlers = {
      onStep: (s) => void this.agent.appendStep(runId, s).catch(() => undefined),
      // v1: handle these so an unattended run completes. The durable "ask me / approve" relay
      // to our Waitpoint + Telegram lands in BEA-620.
      onApproval: async (a) => {
        await this.agent.appendStep(runId, { label: 'Skipped a risky command (needs your OK)', status: 'info', detail: a.command }).catch(() => undefined);
        return 'deny';
      },
      onClarify: async (q) => {
        await this.agent.appendStep(runId, { label: 'Agent had a question', status: 'info', detail: q.question }).catch(() => undefined);
        return 'Use your best judgment and proceed.';
      },
    };

    let result;
    try {
      result = await this.hermes.runTurn(input.prompt, handlers, { title: input.title });
    } catch (e: any) {
      await this.agent.finishRun(runId, { status: 'failed', error: friendlyError(e?.message) });
      return;
    }

    if (result.status === 'error') {
      await this.agent.finishRun(runId, { status: 'failed', error: friendlyError(result.error) });
      return;
    }

    const text = (result.finalText || '').trim();
    if (input.save !== false && text) {
      await this.agent.appendStep(runId, { label: 'Saving the result', status: 'running' });
      try {
        const doc = await this.documents.create({
          title: input.title || 'Agent result',
          contentText: text,
          kind: 'md',
          collectionId: input.saveCollectionId ?? null,
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
