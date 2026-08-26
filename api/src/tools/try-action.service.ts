import { Injectable, Logger } from '@nestjs/common';
import { ServiceActionsService } from './service-actions.service';
import { ToolCatalogService } from './tool-catalog.service';

/** How many real calls one build may make. Enough to look around; not enough to run away. */
export const TRY_BUDGET = 25;

/** How much of a real answer comes back. Enough to see the shape and the values that matter. */
const ANSWER_CHARS = 12_000;

export type TryResult = {
  ok: boolean;
  /** The answer the vendor really sent, trimmed. */
  data?: any;
  truncated?: boolean;
  error?: string;
  /** Set when the call was refused before it happened, with the reason in plain words. */
  refused?: string;
  /** Argument names this action does not take, so they were never sent. */
  droppedArgs?: string[];
  /** Calls left in this build's budget. */
  left?: number;
};

/**
 * TRY IT WHILE YOU BUILD (BEA-1484).
 *
 * The owner, after thirteen builds in one day: *"today we make this work. Tomorrow one more will
 * fail. the code has to work every agent that we create."*
 *
 * He was right, and the cause was structural rather than any one bug. Codex was asked to write a
 * whole program **blind** — it could read documents about his tools but could not call one — so it
 * guessed reasonably from good documentation and found out the truth by failing in production, one
 * fact per rebuild, ten minutes apart, with me in the middle.
 *
 * A person doing the same job opens a console: calls Gmail once, looks at what came back, tries a
 * Notion page, sees it refused, fixes it. Fifty small discoveries in five minutes.
 *
 * This gives Codex that console, and since BEA-1491 it is the WHOLE console — reads and writes alike.
 *
 * It was reads-only at first, and that turned out to be the single remaining cause of repeated
 * failures. Four builds of his daily-email agent failed in a row and **every one failed on a write**:
 * Notion's `parent_id`, then reading a created page's id, then `content_blocks[].content_block`. It
 * got every read right, because it could try those. It got the writes wrong, because for those it was
 * working blind from a written description — and when that description was itself cut off mid-sentence
 * there was nothing it could have done.
 *
 * He was asked directly, with the irreversible-send risk spelled out, and chose **"everything, no
 * exceptions"** — consistent with what he had already said twice: *"Truly everything goes — zero
 * forced rules"* and *"dont guard Codex. it is AI it can deside properly."* So nothing here refuses
 * an action for what it does. A trial send really sends; a trial create really creates.
 *
 * What remains is not a guard on judgement, it is a guard on runaways: a per-build call budget, and a
 * cap on how much of an answer comes back. Every call is written to the owner's ledger like any other,
 * so what a build did while it was thinking is never a mystery — which matters more now, not less.
 *
 * Judgement is handed to Codex WITH THE CONTEXT TO USE IT, in the build prompt rather than as a rule
 * here: prefer creating throwaway things you can archive, and remember a message to a person cannot be
 * taken back. That is the difference between trusting it and hoping.
 */
@Injectable()
export class TryActionService {
  private readonly log = new Logger('TryAction');
  /** Calls used, per build key. In memory: a build is minutes long and a restart ends it anyway. */
  private readonly used = new Map<string, number>();

  constructor(
    private readonly actions: ServiceActionsService,
    // Optional + LAST — spec harnesses build this positionally with fewer arguments.
    private readonly catalog?: ToolCatalogService,
  ) {}

  /** A fresh budget for a build that is starting. */
  reset(key: string): void {
    this.used.delete(String(key || ''));
  }

  async run(key: string, actionId: string, args: Record<string, any>): Promise<TryResult> {
    const id = String(actionId || '').trim();
    const buildKey = String(key || 'build');
    if (!id.startsWith('svc:')) return { ok: false, refused: 'Give an action id that starts with "svc:". Use list_tools and tool_doc to find one.' };

    const spent = this.used.get(buildKey) || 0;
    if (spent >= TRY_BUDGET) {
      return { ok: false, refused: `You have used all ${TRY_BUDGET} trial calls for this build. Write the program from what you have learned — and where you are still unsure, handle both shapes rather than guessing one.`, left: 0 };
    }

    this.used.set(buildKey, spent + 1);
    const r: any = await this.actions
      // The build key rides as the runId (BEA-1492), so every trial call is attributable to the build
      // that made it. Before this it was written with an empty runId and the only way to answer "what
      // did that build touch?" was to query the database by time window and hope two builds had not
      // overlapped.
      .runDetailed(id, buildKey, { runKind: 'build', args: args && typeof args === 'object' ? args : {}, argsPinned: true, label: id })
      .catch((e: any) => ({ ok: false, error: String(e?.message || e) }));

    const left = TRY_BUDGET - (spent + 1);
    if (!r?.ok) return { ok: false, error: String(r?.error || 'the call failed'), left, ...(r?.droppedArgs?.length ? { droppedArgs: r.droppedArgs } : {}) };

    let json = '';
    try { json = JSON.stringify(r.data ?? null); } catch { json = ''; }
    const truncated = json.length > ANSWER_CHARS;
    this.log.log(`build ${buildKey.slice(0, 8)} tried ${id} — ${truncated ? `${Math.round(json.length / 1024)}KB, trimmed` : 'ok'}, ${left} left`);
    return {
      ok: true,
      // An oversized answer comes back as trimmed TEXT, not as null. Seeing the first 12KB of a real
      // payload is most of the value; being handed nothing and told it was fine is the opposite.
      data: truncated ? `${json.slice(0, ANSWER_CHARS)}… (trimmed — the real answer was ${Math.round(json.length / 1024)}KB)` : r.data,
      ...(truncated ? { truncated: true } : {}),
      ...(r.droppedArgs?.length ? { droppedArgs: r.droppedArgs } : {}),
      left,
    };
  }

}
