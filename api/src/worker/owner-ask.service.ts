import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { AlertsService } from '../push/alerts.service';
import { whatsappStepLabel } from '../contacts/owner-alert';
import { askTag, numberedChoices, pickAsk, readOwnerAnswer, sameNumber, setOwnerReplyHandler } from '../contacts/owner-reply';
import { ServiceGatesService } from '../tools/service-gates.service';

/** The owner's decision, 12 hours (his own choice) — a question is never left open for ever. */
export const ASK_DEADLINE_HOURS = 12;

/**
 * How long an inbound message id is remembered, so a Postbox retry of the SAME message cannot
 * answer a second question (see `onOwnerReply`). Minutes are enough — a retry follows within
 * seconds — and it is in memory on purpose: a restart loses nothing that matters.
 */
const SEEN_MS = 60 * 60_000;

/**
 * The question road (BEA-1392, agent workers 7/10 — `specs/AGENT-WORKERS.md` §H).
 *
 * The owner's own requirement: *"If something goes wrong, the worker has to send a WhatsApp
 * message, and it has to read my reply. There will be some big agents which take a lot of time to
 * execute."* So a worker that cannot decide something alone parks the run, asks on WhatsApp, and
 * exits — a two-day wait costs nothing — and his reply, whenever it comes, answers the waitpoint
 * and the worker sweeper starts the run again from its journal.
 *
 * Two halves, both here so they cannot drift apart:
 *  - **out**: `send()` — one line through `AlertsService.askOwner()`, which is `sendOwnerAlert()`,
 *    so the template-first order, Meta's real verdict and the Telegram fallback (BEA-1379) come
 *    free. v1 is free text with numbered choices; tappable buttons are a later piece.
 *  - **back**: `onOwnerReply()` — registered on the callback controller's registry at boot, ahead
 *    of its Contact lookup. It answers ONLY a question WhatsApp itself asked and is still holding.
 *    Everything else falls through to the contact road exactly as it does today.
 */
@Injectable()
export class OwnerAskService implements OnModuleInit {
  private readonly log = new Logger('OwnerAsk');
  /** Inbound message ids already acted on — `wamid` → when. */
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly agent: AgentService,
    // Optional + LAST — spec harnesses build this positionally with fewer args.
    private readonly alerts?: AlertsService,
    private readonly gates?: ServiceGatesService,
  ) {}

  onModuleInit() {
    // The answerer lives here, but the inbound message lands in ContactsModule. A registry rather
    // than an import — ContactsModule is already imported by this module's own dependencies, so an
    // import back would be a cycle (the `setOwnerAlertTelegram` pattern).
    setOwnerReplyHandler({
      isOwnerNumber: (from: string) => this.isOwnerNumber(from),
      onOwnerReply: (text: string, meta?: { wamid?: string | null }) => this.onOwnerReply(text, meta),
    });
    // A can't-undo call a worker parked on is settled by whichever road answered the question —
    // WhatsApp, the run screen, Telegram, or the 12-hour timeout taking the question's own default.
    // Settling it only on the WhatsApp road would leave a timed-out gate `pending` for ever, and the
    // resumed worker would park and message him again every twelve hours.
    this.agent.setAnswerHook?.(async (runId: string, answer: string, _via: string, waitpointId?: string) => {
      await Promise.resolve(this.gates?.settlePending?.(runId, answer)).catch(() => undefined);
      // EVERY listener hears it, not just the last one to register (BEA-1505).
      //
      // This used to be one slot, and two services claimed it: the old brief road and the new goal
      // road. Whichever booted last silently erased the other. The goal road lost — so when he
      // replied "Keep it" on WhatsApp the agent was never switched on, its schedule was never set,
      // and the run was never finished. Twenty minutes later the stall watchdog marked a run that had
      // already saved his document as failed. He had kept two agents; both stayed switched off.
      //
      // One listener throwing must never stop the others hearing it, so each is called on its own.
      for (const w of this.watchers) {
        // try/catch around the CALL, not `.catch()` on its result: a listener that throws
        // synchronously never returns a promise to attach a catch to, and would take the whole
        // answer down with it — including the listeners after it in the list.
        try {
          await w(runId, answer, waitpointId);
        } catch (e: any) {
          this.log?.warn?.(`a listener could not act on his answer: ${e?.message || e}`);
        }
      }
    });
  }

  /** Is this inbound number the owner's own? A missing setting means "no" — never "everyone". */
  async isOwnerNumber(from: string): Promise<boolean> {
    const mine = await this.alerts?.ownerNumber?.().catch(() => null);
    return !!mine && sameNumber(from, mine);
  }

  /**
   * Send one question to the owner's phone and say on the run what happened to it. Never throws:
   * a question that could not be delivered still leaves the run parked and answerable in the app,
   * and the step says plainly that the message did not go out.
   */
  async send(runId: string, waitpointId: string, msg: { jobName: string; question: string; choices?: string[] }): Promise<{ sent: boolean }> {
    const tag = askTag(waitpointId);
    const r = await this.alerts
      ?.askOwner?.({ jobName: msg.jobName, question: msg.question, choices: msg.choices, tag, path: `/agent/runs/${runId}` })
      .catch((e: any) => ({ sent: false, why: String(e?.message || e) }) as any);
    const label = whatsappStepLabel(r);
    const numbered = numberedChoices(msg.choices);
    await this.agent
      .appendStep(runId, {
        label: `${label.label} — asked you: ${String(msg.question).slice(0, 160)}${tag ? ` (${tag})` : ''}`,
        status: label.status,
        detail: numbered ? `Reply on WhatsApp with ${numbered}` : 'Reply on WhatsApp, or answer it here.',
        kind: 'ask',
      })
      .catch(() => undefined);
    if (!r?.sent) this.log.warn(`the question for run ${runId} did not reach WhatsApp: ${(r as any)?.why || (r as any)?.error || 'unknown reason'}`);
    return { sent: !!r?.sent };
  }

  /**
   * The owner wrote back. Answers the question WhatsApp asked — the one he named with its tag, else
   * the oldest — and settles whatever that run was holding for approval.
   *
   * `answered: false` means nothing here was his to answer, and the caller carries on down its
   * normal road as if this method did not exist. That is the whole safety rule of this piece.
   */
  /**
   * Everyone who wants to hear a run's question being answered — whichever road answered it
   * (BEA-1418), and now ALL of them rather than only the last to ask (BEA-1505).
   *
   * A list, never one slot. Two services register here and a single slot silently dropped one of
   * them, which is how "Keep it" stopped keeping anything.
   */
  private readonly watchers: ((runId: string, answer: string, waitpointId?: string) => Promise<void> | void)[] = [];

  setAnswerWatcher(fn: (runId: string, answer: string, waitpointId?: string) => Promise<void> | void) {
    if (typeof fn !== 'function') return;
    if (!this.watchers.includes(fn)) this.watchers.push(fn);
  }

  async onOwnerReply(text: string, meta?: { wamid?: string | null }): Promise<{ answered: boolean; waitpointId?: string }> {
    // Postbox retries a callback it thinks was not taken. Answering the same question twice is
    // harmless (the answer is atomic), but answering the NEXT open question with the same words
    // would not be — so one message decides one question, whatever the gateway does.
    const wamid = String(meta?.wamid || '').trim();
    if (wamid) {
      const cutoff = Date.now() - SEEN_MS;
      for (const [k, at] of this.seen) if (at < cutoff) this.seen.delete(k);
      if (this.seen.has(wamid)) return { answered: true }; // this message already answered something
    }
    const open = await this.agent.openWhatsAppAsks().catch(() => [] as any[]);
    if (!open.length) return { answered: false };
    const wp: any = pickAsk(open as any, text);
    if (!wp) return { answered: false };
    const choices = Array.isArray(wp.options) ? wp.options.map((c: any) => String(c)) : [];
    const { answer } = readOwnerAnswer(text, choices);
    if (!answer.trim()) return { answered: false }; // a tag with nothing after it is not an answer

    const res: any = await this.agent.answerById(wp.id, answer, 'whatsapp').catch((e: any) => {
      this.log.warn(`could not apply the owner's answer to ${wp.id}: ${e?.message || e}`);
      return null;
    });
    if (!res) return { answered: false };
    if (wamid) this.seen.set(wamid, Date.now()); // this message has now decided a question
    if (res.applied) {
      // Whatever the answer settles beyond the waitpoint itself — a held can't-undo call — happens
      // inside `answerById` → `resolve()`, on the hook registered above, so every road settles it.
      await this.agent
        .appendStep(wp.runId, { label: `You answered on WhatsApp: ${answer.slice(0, 160)}`, status: 'done', kind: 'ask' })
        .catch(() => undefined);
    }
    // Already answered elsewhere (the run screen, Telegram) — it was still his message, so it must
    // not fall through and be stored as a contact's reply.
    return { answered: true, waitpointId: wp.id };
  }
}
