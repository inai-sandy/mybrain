import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AgentService } from '../agent/agent.service';
import { LlmService } from '../llm/llm.service';
import { AlertsService } from '../push/alerts.service';
import { whatsappStepLabel } from '../contacts/owner-alert';
import { ServiceActionsService } from '../tools/service-actions.service';
import { GatePause } from '../tools/service-gates.service';
import { SocialAgentRunService, SHAPE_MAX_TOKENS, mergeTables } from '../social/social-agent-run.service';
import { SocialBudgetService, BudgetCheck } from '../social/social-budget.service';
import { SourceFetchService } from '../social/source-fetch.service';
import { planFromAgent, sourceHint, sourceLabel, clampPages } from '../social/plan';
import { tableOf } from '../social/rows';
import { RunJournalService } from './run-journal.service';
import { WorkerTokenGuard } from './worker-token.guard';
import { WorkerTokenService } from './worker-token.service';

/**
 * The helpers a worker's AI step may use. Anything else is refused — a worker never picks its own
 * model or its own prompt budget, and a helper key that is not registered would fall through to the
 * app's general model (the trap `completeHelper` exists to close).
 */
export const WORKER_HELPERS = ['social-shape', 'social-alert'];

/** The most tokens one generic worker AI call may ask for. The shaping mode has its own ceiling. */
const AI_MAX_TOKENS = SHAPE_MAX_TOKENS;

/**
 * The callback API (BEA-1387, agent workers 2/10 — `specs/AGENT-WORKERS.md` §C).
 *
 * A worker is a small program on the host with no database, no keys and no vendor access. Everything
 * it does, it asks the app to do: the fetch (paged and de-duped **server-side**, because paging
 * depends on the know-how cards), the AI step, the sheet, the message, the run's own steps. So the
 * credit ceiling, the can't-undo gate, the `ToolCall` flight recorder and account resolution all
 * keep working exactly as they do for the plan runner, for free.
 *
 * Two rules hold this together:
 *  - **Identity comes from the token, never from the body.** `runId`/`agentId` are read off the
 *    run-scoped token by `WorkerTokenGuard`; the routes are `@Public()` only so the owner's session
 *    guard steps aside, and a browser session reaches nothing here.
 *  - **Every effectful call is journalled** (`RunJournalService`), keyed by its position in the call
 *    order. A resumed worker re-runs from the top and its earlier calls return their recorded values
 *    — zero repeat fetches, zero repeat sheet writes, zero repeat messages.
 */
@Public()
@UseGuards(WorkerTokenGuard)
@Controller('api/worker')
export class WorkerController {
  constructor(
    private readonly journal: RunJournalService,
    private readonly tokens: WorkerTokenService,
    private readonly agent: AgentService,
    private readonly actions: ServiceActionsService,
    private readonly sources: SourceFetchService,
    private readonly social: SocialAgentRunService,
    private readonly llm: LlmService,
    // Optional + LAST — spec harnesses build this positionally with fewer args.
    private readonly budget?: SocialBudgetService,
    private readonly alerts?: AlertsService,
  ) {}

  // ---- fetching ------------------------------------------------------------------------------

  /**
   * The whole paged, de-duped fetch of one source, server-side (`kit.fetchSource`). `{sourceId}`
   * names a block of the job's own plan — a plain source or a creators-first block, both fetched by
   * the ONE fetcher `runPlan()` uses. `{actionId, args}` is the single pinned call, for the steps a
   * plan has no block for.
   */
  @Post('tool')
  async tool(@Req() req: any, @Body() body: any) {
    return this.saying(() => this.fetch(req, body));
  }

  private async fetch(req: any, body: any) {
    const { runId, agentId } = who(req);
    const seq = seqOf(body);
    const job = await this.job(agentId);
    const step = this.stepper(runId);
    const progress = (label: string) => this.agent.stampProgress?.(runId, label);

    if (body?.sourceId) {
      const plan = planFromAgent(job);
      const src = plan.sources.find((s) => s.id === String(body.sourceId));
      if (!src) throw new BadRequestException(`This job has no source called "${body.sourceId}".`);
      // Pages are the plan's unless the worker asks for fewer/more, and always inside the cap.
      if (src.kind === 'source' && body.pages !== undefined && body.pages !== null) src.pages = clampPages(body.pages);
      const args = { sourceId: src.id, pages: src.kind === 'source' ? src.pages : 0 };
      // The whole paged fetch is ONE journal step, on purpose: the pages of a source are one
      // answer, and a per-page journal would have to invent sub-positions the worker cannot know.
      // The narrow cost, said out loud: if this ever throws MID-loop — not one of the controlled
      // `{stop}` answers, but a real exception after some pages were already billed — nothing is
      // journalled and a resume re-fetches from page 1. `runDetailed()` answers rather than throws
      // on every vendor road, which is what keeps that narrow; it is the reason it must stay so.
      const hit = await this.journal.once(runId, seq, 'fetchSource', args, async () => {
        const out = await this.sources.fetchBlock(src, this.guard(runId, job), this.ctx(runId, job), step, { hint: sourceHint(src, plan.sources), progress });
        const label = sourceLabel(src, plan.sources);
        return {
          ok: !out.stop,
          label,
          credits: out.credits,
          empty: !!out.empty,
          why: out.why || null,
          stop: out.stop || null,
          table: out.r ? tableOf(out.r.data) : null,
        };
      });
      return { ...(hit.value as any), replayed: hit.replayed };
    }

    const actionId = String(body?.actionId || '');
    if (!actionId.startsWith('svc:')) throw new BadRequestException('Give a sourceId from the job\'s plan, or an actionId that starts with "svc:".');
    const args = body?.args && typeof body.args === 'object' ? body.args : {};
    const hit = await this.journal.once(runId, seq, 'tool', { actionId, args }, async () => {
      const stop = await this.guard(runId, job)(actionId);
      if (stop) return { ok: false, credits: 0, stop, table: null };
      const r = await this.actions.runDetailed(actionId, '', this.ctx(runId, job)(actionId, args));
      return {
        ok: !!r.ok,
        credits: Number(r.credits) || 0,
        error: r.error || null,
        notFound: !!r.notFound,
        stop: r.ok ? null : r.error || 'the call failed',
        table: r.ok ? tableOf(r.data) : null,
      };
    });
    return { ...(hit.value as any), replayed: hit.replayed };
  }

  /**
   * Several sources' tables → one (`kit.merge`), by `mergeTables()` — the same union, the same
   * `source` column, the same de-dupe on the union's id column the plan runner uses. Pure and free,
   * so it is not journalled: a replay recomputes it from what it was given.
   */
  @Post('merge')
  async merge(@Body() body: any) {
    const tables = Array.isArray(body?.tables) ? body.tables : [];
    if (!tables.length) throw new BadRequestException('Nothing to merge.');
    const clean = tables.map((t: any, i: number) => ({ id: String(t?.id || `source ${i + 1}`), table: asTable(t?.table) }));
    if (clean.length === 1) return { ...clean[0].table };
    return mergeTables(clean);
  }

  // ---- the AI step ---------------------------------------------------------------------------

  /**
   * `kit.shape` (rows in the body) or a plain helper call. Shaping runs the app's OWN batching,
   * prompt and salvage — the same `shape()` the plan runner calls — so a worker's rows and the plan
   * runner's rows come out of the same code, not out of two prompts that drifted apart.
   */
  @Post('ai')
  async ai(@Req() req: any, @Body() body: any) {
    const { runId } = who(req);
    const seq = seqOf(body);
    const helper = String(body?.helper || '');
    if (!WORKER_HELPERS.includes(helper)) throw new BadRequestException(`"${helper || 'that'}" is not a helper a worker may use (${WORKER_HELPERS.join(', ')}).`);

    if (body?.table) {
      const table = asTable(body.table);
      const prompt = String(body?.prompt || '');
      const header = Array.isArray(body?.header) && body.header.length ? body.header.map((h: any) => String(h)) : null;
      const hit = await this.journal.once(runId, seq, 'shape', { prompt, header, rows: table.rows.length, columns: table.columns }, async () => {
        const start = new Date();
        await this.agent.stampProgress?.(runId, `shaping ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`);
        const shaped = await this.social.shape(prompt, table, header);
        let aiTokens = 0;
        try { aiTokens = (await this.llm.tokensSince?.('social-shape', start)) || 0; } catch { aiTokens = 0; }
        return { ok: !!shaped.ok, columns: shaped.columns || null, rows: shaped.rows || null, note: shaped.note || null, error: shaped.error || null, aiTokens };
      });
      return { ...(hit.value as any), replayed: hit.replayed };
    }

    const prompt = String(body?.prompt || '');
    if (!prompt.trim()) throw new BadRequestException('An AI step needs a prompt, or a table to shape.');
    const maxTokens = Math.min(Math.max(1, Number(body?.maxTokens) || 1000), AI_MAX_TOKENS);
    const hit = await this.journal.once(runId, seq, 'ai', { helper, prompt, maxTokens }, async () => {
      const text = await this.llm.completeHelper(helper as any, prompt, maxTokens, helper).catch((e: any) => {
        throw new Error(`the ${helper} model could not be reached — ${String(e?.message || e).slice(0, 120)}`);
      });
      return { ok: !!text, text: text || null };
    });
    return { ...(hit.value as any), replayed: hit.replayed };
  }

  // ---- the run's own words -------------------------------------------------------------------

  /**
   * One readable line on the run screen (`kit.step`), or a checkpoint (`kit.checkpoint`).
   *
   * A step is journalled, so a resumed worker does not write its first half of the log twice. A
   * **checkpoint is not**: it is the "still moving" stamp the stall watchdog reads, and it must be
   * fresh on every spawn, not replayed from yesterday.
   */
  @Post('step')
  async step(@Req() req: any, @Body() body: any) {
    const { runId } = who(req);
    const label = String(body?.label || '').slice(0, 400);
    if (!label.trim()) throw new BadRequestException('A step needs a label.');
    if (body?.kind === 'checkpoint') {
      await this.agent.stampProgress?.(runId, label);
      return { ok: true, checkpoint: true };
    }
    const s = { label, status: String(body?.status || 'done'), detail: body?.detail ? String(body.detail).slice(0, 1200) : undefined, kind: body?.kind ? String(body.kind) : undefined, nodeId: body?.nodeId ? String(body.nodeId) : undefined };
    const hit = await this.journal.once(runId, seqOf(body), 'step', s, async () => {
      await this.agent.appendStep(runId, s).catch(() => undefined);
      return { ok: true };
    });
    return { ...(hit.value as any), replayed: hit.replayed };
  }

  // ---- output --------------------------------------------------------------------------------

  /** The rows → the job's Google Sheet, or a Document (`kit.writeSheet` / `kit.writeDocument`). */
  @Post('output')
  async output(@Req() req: any, @Body() body: any) {
    return this.saying(() => this.write(req, body));
  }

  private async write(req: any, body: any) {
    const { runId, agentId } = who(req);
    const seq = seqOf(body);
    const job = await this.job(agentId);
    const step = this.stepper(runId);
    const kind = String(body?.kind || 'document');
    const title = String(body?.title || job?.name || 'Agent result').slice(0, 200);

    if (kind === 'sheet') {
      const table = asTable(body?.table);
      if (!table.rows.length) throw new BadRequestException('There are no rows to write.');
      const append = body?.append === undefined ? !!job?.sheetId || !!job?.sheetAppend : !!body.append;
      const hit = await this.journal.once(runId, seq, 'writeSheet', { title, append, columns: table.columns, rows: table.rows }, async () => {
        const w = await this.social.writeRowsToSheet(runId, job, title, table, { append, step });
        return { ok: !!w.ok, url: w.url || null, id: w.id || null, created: !!w.created, skipped: w.skipped || 0, nothingNew: !!w.nothingNew, rows: w.table?.rows?.length ?? 0, error: w.error || null };
      });
      return { ...(hit.value as any), replayed: hit.replayed };
    }

    const markdown = String(body?.markdown || '');
    if (!markdown.trim()) throw new BadRequestException('A document needs something in it.');
    const hit = await this.journal.once(runId, seq, 'writeDocument', { title, markdown }, async () => {
      const d = await this.social.writeDocument(runId, title, markdown, { step, detail: title });
      return { ok: !!d.ok, docId: d.docId || null, error: d.error || null };
    });
    return { ...(hit.value as any), replayed: hit.replayed };
  }

  // ---- telling the owner ----------------------------------------------------------------------

  /**
   * The finished result on WhatsApp (through the one owner path — template first, Meta's real
   * verdict, Telegram if Meta refuses, BEA-1379) and/or on Telegram. Journalled, so a resumed run
   * never sends the same message twice.
   */
  @Post('notify')
  async notify(@Req() req: any, @Body() body: any) {
    const { runId, agentId } = who(req);
    const seq = seqOf(body);
    const job = await this.job(agentId);
    const step = this.stepper(runId);
    const headline = String(body?.headline || '').slice(0, 600);
    if (!headline.trim()) throw new BadRequestException('A message needs a headline.');
    const detail = body?.detail ? String(body.detail).slice(0, 1200) : '';
    const url = String(body?.url || `/agent/runs/${runId}`);
    const wantWhatsApp = !!body?.whatsapp;
    const wantTelegram = !!body?.telegram;
    if (!wantWhatsApp && !wantTelegram) throw new BadRequestException('Say where the message goes: whatsapp, telegram, or both.');
    const title = String(body?.title || job?.name || 'Your agent').slice(0, 120);

    const hit = await this.journal.once(runId, seq, 'notify', { headline, detail, url, whatsapp: wantWhatsApp, telegram: wantTelegram }, async () => {
      const out: any = { ok: false, whatsapp: null, telegram: null };
      if (wantTelegram) {
        const tg = await this.budget?.pushAlert?.(job, `${headline}${detail ? `\n\n${detail}` : ''}`, runId).catch((e: any) => ({ sent: false, why: String(e?.message || e) }));
        out.telegram = { sent: !!tg?.sent, why: tg?.why || null };
        await step({ label: tg?.sent ? 'Sent on Telegram' : `⚠️ Not sent on Telegram — ${tg?.why || 'Telegram is not set up'}`, status: tg?.sent ? 'done' : 'info', nodeId: 'notify' });
      }
      if (wantWhatsApp) {
        const wa = await this.alerts?.runFinished?.(title, headline, url, detail ? { detail } : {}).catch((e: any) => ({ sent: false, why: String(e?.message || e) }));
        out.whatsapp = { sent: !!wa?.sent, why: (wa as any)?.why || null };
        await step({ ...whatsappStepLabel(wa), nodeId: 'notify' });
      }
      out.ok = !!out.whatsapp?.sent || !!out.telegram?.sent;
      return out;
    });
    return { ...(hit.value as any), replayed: hit.replayed };
  }

  // ---- asking, and waiting ---------------------------------------------------------------------

  /**
   * `kit.ask` — the worker stops and asks the owner something (§H). The waitpoint is written, the
   * run goes to `awaiting_input`, this run's tokens are revoked, and the worker EXITS: nothing is
   * held open, so a two-day wait costs nothing.
   *
   * The journal makes the resume free. The question's row is written the moment it is asked
   * (`{waiting:true}`); when the answer lands, the SAME position returns the answer, so the worker
   * carries on from where it stopped and everything before the question is replayed, not redone.
   */
  @Post('ask')
  async ask(@Req() req: any, @Body() body: any) {
    const { runId } = who(req);
    const seq = seqOf(body);
    const question = String(body?.question || '').trim();
    if (!question) throw new BadRequestException('A question needs to say something.');
    const choices = Array.isArray(body?.choices) ? body.choices.map((c: any) => String(c)).slice(0, 6) : [];
    const ifNoAnswer = body?.ifNoAnswer === undefined || body?.ifNoAnswer === null ? null : String(body.ifNoAnswer);
    if (choices.length && ifNoAnswer === null) throw new BadRequestException('A question with choices must say what to do if nobody answers (ifNoAnswer).');
    const deadlineHours = Math.min(Math.max(Number(body?.deadlineHours) || 12, 1), 24 * 14);
    const stepKey = this.journal.stepKey(seq, 'ask', { question, choices });

    const found = await this.journal.read(runId, seq);
    if (found) {
      if (found.stepKey !== stepKey) throw new BadRequestException(`This run already asked something else at call ${seq} — the worker is not repeatable, and nothing was asked again.`);
      const v: any = found.value || {};
      if (!v.waiting) return { ...v, replayed: true };
      // Still the same open question: has it been answered since?
      const wp = v.waitpointId ? await this.agent.getWaitpointById(v.waitpointId).catch(() => null) : null;
      const answer = answerOf(wp);
      // Out of time with nothing to fall back on: the run stops honestly rather than waiting for
      // ever on a question that can no longer be answered (§H — "a question is never left open").
      if (answer === null && wp && wp.status !== 'pending') {
        throw new BadRequestException(`"${question.slice(0, 120)}" was never answered, and this question named no default — the run cannot carry on by itself.`);
      }
      if (answer === null) {
        this.tokens.revokeRun(runId);
        return { waiting: true, waitpointId: v.waitpointId, question, replayed: true };
      }
      const answered = { waiting: false, answer, waitpointId: v.waitpointId };
      await this.journal.write(runId, seq, stepKey, 'ask', answered);
      return { ...answered, replayed: true };
    }

    const wp: any = await this.agent.ask(runId, {
      question,
      kind: choices.length ? 'choice' : 'free_text',
      options: choices,
      defaultValue: ifNoAnswer ?? undefined,
      expiresInMs: deadlineHours * 3600_000,
    } as any);
    await this.journal.write(runId, seq, stepKey, 'ask', { waiting: true, waitpointId: wp?.id || null });
    await this.agent.appendStep(runId, { label: `Waiting for you: ${question.slice(0, 200)}`, status: 'running', kind: 'ask' }).catch(() => undefined);
    this.tokens.revokeRun(runId);
    return { waiting: true, waitpointId: wp?.id || null, question };
  }

  // ---- the end ---------------------------------------------------------------------------------

  /**
   * The run is over (`kit.finish` / `kit.fail`). The spawn's tokens stop working the same moment,
   * and the run's journal is dropped: it existed to make a resume free, and a finished run is never
   * resumed — leaving it would keep every fetched table in the database for ever.
   */
  @Post('finish')
  async finish(@Req() req: any, @Body() body: any) {
    const { runId } = who(req);
    const status = body?.status === 'failed' ? 'failed' : body?.status === 'cancelled' ? 'cancelled' : 'done';
    const error = body?.error ? String(body.error).slice(0, 2000) : undefined;
    if (status === 'failed' && error) await this.agent.appendStep(runId, { label: error, status: 'failed' }).catch(() => undefined);
    const run = await this.agent.finishRun(runId, {
      status: status as any,
      error,
      resultText: body?.resultText ? String(body.resultText) : undefined,
      outputUrl: body?.outputUrl ? String(body.outputUrl) : undefined,
      outputDocId: body?.outputDocId ? String(body.outputDocId) : undefined,
    });
    this.tokens.revokeRun(runId);
    await this.journal.forget(runId);
    return { ok: true, status: (run as any)?.status || status };
  }

  // ---- shared plumbing --------------------------------------------------------------------------

  /**
   * A can't-undo gate is thrown, never returned (`GatePause`). Out of a controller it would leave
   * the process as a bare 500 — "Internal server error" — and the worker would say nothing useful.
   * So it comes back as the gate's own plain sentence, and NOTHING is journalled: the call never
   * happened, so a later approval may still make it. (A worker parking on a gate is piece 7.)
   */
  private async saying<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e: any) {
      if (e instanceof GatePause || e?.name === 'GatePause') throw new BadRequestException(String(e?.message || 'Held for your approval.'));
      throw e;
    }
  }

  private async job(agentId: string | null): Promise<any> {
    if (!agentId) throw new BadRequestException('This run is not attached to a job.');
    const job = await this.agent.getAgent(agentId).catch(() => null);
    if (!job) throw new BadRequestException('That job no longer exists.');
    return job;
  }

  private stepper(runId: string) {
    return (s: any) => this.agent.appendStep(runId, s).catch(() => undefined);
  }

  /**
   * The daily credit ceiling, before EVERY call — the same guard the plan runner uses, fail-closed:
   * a guard that cannot answer does not let the call through, and a call over the ceiling pauses the
   * job instead of being made.
   */
  private guard(runId: string, job: any) {
    return async (actionId: string): Promise<string | null> => {
      let b: BudgetCheck | null = null;
      if (this.budget?.check) {
        try { b = await this.budget.check(actionId); } catch (e: any) {
          return `Could not check the daily Social credit ceiling (${String(e?.message || e).slice(0, 120)}) — the call was not made. Try again in a minute.`;
        }
      }
      if (b && !b.ok) {
        await this.budget!.pauseAgent(job, b.reason!, runId).catch(() => undefined);
        return b.reason!;
      }
      return null;
    };
  }

  /** Every worker call is recorded like everyone else's: the run, the job, `runKind:'worker'`, pinned args. */
  private ctx(runId: string, job: any) {
    return (id: string, args: Record<string, any>) => ({ runId, runKind: 'worker', agentId: job?.id, args, argsPinned: true, label: id });
  }
}

/** The identity the guard put on the request. Never read from the body — that is the whole rule. */
function who(req: any): { runId: string; agentId: string | null } {
  const w = req?.worker;
  if (!w?.runId) throw new BadRequestException('No worker run on this request.');
  return { runId: w.runId, agentId: w.agentId || null };
}

/** Where this call sits in the run's call order. The worker counts; the app records against it. */
function seqOf(body: any): number {
  const n = Number(body?.seq);
  if (!Number.isInteger(n) || n < 0) throw new BadRequestException('Every worker call carries its own "seq" — its place in the run\'s call order.');
  return n;
}

/** A table as it crosses the wire, checked so a malformed body cannot become half a sheet. */
function asTable(t: any): { columns: string[]; rows: any[][]; itemCount: number } {
  const columns = Array.isArray(t?.columns) ? t.columns.map((c: any) => String(c)) : [];
  const rows = Array.isArray(t?.rows) ? t.rows.filter((r: any) => Array.isArray(r)) : [];
  if (!columns.length) throw new BadRequestException('A table needs its columns.');
  return { columns, rows, itemCount: Number(t?.itemCount) || rows.length };
}

/** An answered waitpoint's answer, or null while it is still open. */
function answerOf(wp: any): string | null {
  if (!wp) return null;
  if (wp.status === 'answered') return typeof wp.answer === 'string' ? wp.answer : JSON.stringify(wp.answer ?? '');
  if (wp.status === 'expired') return wp.defaultValue ?? null;
  return null;
}
