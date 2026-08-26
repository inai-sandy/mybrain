import { Injectable, Logger } from '@nestjs/common';
import { ServiceActionsService } from './service-actions.service';
import { ToolCatalogService } from './tool-catalog.service';
import { isReadAction } from './service-provider';

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
 * This gives Codex that console. One rule makes it safe rather than terrifying:
 *
 * **READS ONLY.** A build that created Notion pages or sent WhatsApp messages while it was still
 * designing would be far worse than the problem it solves. Read-or-write is decided by the catalog,
 * never guessed here, and it fails CLOSED — an action it cannot classify is treated as a write and
 * refused.
 *
 * The other two limits are about runaways, not about doubting Codex: a per-build budget, and a cap
 * on how much of an answer comes back. Every call is written to the owner's ledger like any other,
 * so what a build did while it was thinking is never a mystery.
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

    if (!(await this.isRead(id))) {
      // The whole safety of this feature. Said as a fact rather than a telling-off, and with the way
      // forward — a build still has to be able to plan a write it cannot make.
      return {
        ok: false,
        refused: `${id} changes something, so it cannot be tried while you are building — only reads can. Read its card for the exact arguments, write the call, and it will run when the agent runs.`,
        left: TRY_BUDGET - spent,
      };
    }

    this.used.set(buildKey, spent + 1);
    const r: any = await this.actions
      .runDetailed(id, '', { runKind: 'build', args: args && typeof args === 'object' ? args : {}, argsPinned: true, label: id })
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

  /**
   * Is this a read? The catalog's own answer, and it fails CLOSED.
   *
   * Being wrong towards "write" refuses a harmless call and costs a sentence. Being wrong the other
   * way sends a real message from a build that was only supposed to be looking.
   */
  private async isRead(actionId: string): Promise<boolean> {
    const id = String(actionId || '');
    const service = id.startsWith('svc:') ? id.slice(4).split('.')[0] : '';
    try {
      const t: any = await this.catalog?.byId?.(id);
      if (t) {
        if (t.risky === true) return false;
        if (t.readOnly === true) return true;
        if (String(t.method || '').toUpperCase() === 'GET') return true;
      }
    } catch { /* the verb below is the fallback, and it fails closed */ }
    return isReadAction(id, service);
  }
}
