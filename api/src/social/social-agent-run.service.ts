import { Injectable, Logger } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { DocumentsService } from '../documents/documents.service';
import { LlmService } from '../llm/llm.service';
import { AlertsService } from '../push/alerts.service';
import { whatsappStepLabel } from '../contacts/owner-alert';
import { PushService } from '../push/push.service';
import { ServiceActionsService, ServiceRunResult } from '../tools/service-actions.service';
import { isServiceToolId } from '../tools/service-provider';
import { Diff, Threshold, diffResults, label as fieldLabel } from './diff';
import { markdownTable, remap, sheetUrl, spreadsheetIdOf, tableOf, valuesGrids, cell, flatten, MAX_ROWS } from './rows';
import { BudgetCheck, SocialBudgetService } from './social-budget.service';
import { SocialWatchStore } from './social-watch.store';

/**
 * A Social agent's run (BEA-1357) — design: `specs/SOCIAL.md`.
 *
 * "A Social agent is an ordinary Agent" — same row, runs, history, schedule, output destinations,
 * WhatsApp toggle. What differs is HOW it runs: its tools are `svc:` ids with pinned arguments, and
 * calling an API is not a decision, so **no engine turn is started for the fetch** (an engine turn
 * is ~118,000 tokens; the fetch is one HTTPS call). Every fetch goes through the ONE run path,
 * `ServiceActionsService.runDetailed()`, so the `ToolCall` row (`runKind:'agent'`, `credits`) is
 * written like everyone else's. The only model call is the shaping step, and only when the owner
 * asked for columns or a filter ("in India" is ours — no social search has a country filter; recall
 * over precision).
 *
 * Output: `outputDest:'sheet'` creates a Google Sheet through the seam (or appends to `sheetId`)
 * and the run links to it; anything else lands in Documents like every other run. Sheets not
 * connected → the run FAILS with "connect Google Sheets first" — never a silent skip. A run may
 * never say done if any step failed.
 *
 * **Watch and Alert (BEA-1358).** `Agent.mode` = `watch`: the same fetch, then a diff against what
 * the job saw last time (`SocialWatch`, `diff.ts`), and the output is ONLY what changed — "3 new
 * items since last time", "followers 37,570 → 38,102". Nothing changed → the run finishes "nothing
 * changed", writes no document and sends nothing. The FIRST run stores a baseline ("watching from
 * now") and never reports the whole list as new. `mode` = `alert`: Watch + a numeric threshold
 * (judged here, once-only — a number that stays above pushes once) and/or a plain-English condition
 * judged by ONE `social-alert` helper call over the diff → when true, a push (Telegram, and WhatsApp
 * through `AlertsService`). The last good result is stored only after every step succeeded, so a
 * failed fetch, write or push never overwrites it. **Before every Social call** the daily credit
 * ceiling is checked (`SocialBudgetService`) — a call that would pass it is NOT made, and the job
 * pauses itself with `pausedReason` and tells the owner.
 */

/** The task text the builder pre-fills. Anything else means "shape the rows as I say". */
export const KEEP_AS_FETCHED = 'Keep every result as fetched.';

/** How many items one shaping call is shown, and how many calls a run may make. */
const SHAPE_BATCH = 60;
const SHAPE_MAX_BATCHES = 8;
const SHAPE_INPUT_CHARS = 60_000;
const SHAPE_MAX_TOKENS = 12_000;

/** The Sheets actions this uses — the seam ids, never a vendor's name (verified live 2026-08-17). */
export const SHEET_CREATE = 'svc:googlesheets.create_google_sheet1';
export const SHEET_WRITE = 'svc:googlesheets.batch_update';
export const SHEET_READ = 'svc:googlesheets.batch_get';
const SHEET_TAB = 'Sheet1';

const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

@Injectable()
export class SocialAgentRunService {
  private readonly log = new Logger('SocialAgentRun');

  constructor(
    private readonly agent: AgentService,
    private readonly actions: ServiceActionsService,
    private readonly llm: LlmService,
    // Optional + LAST — spec files build this positionally with fewer args.
    private readonly documents?: DocumentsService,
    private readonly alerts?: AlertsService,
    private readonly push?: PushService,
    private readonly budget?: SocialBudgetService, // the daily credit ceiling (BEA-1358)
    private readonly watches?: SocialWatchStore, // what a Watch/Alert saw last time (BEA-1358)
  ) {}

  /**
   * Is this job a direct fetch? Every tool is a `svc:` id AND each has pinned arguments. A job with
   * a bare `svc:` id and no arguments is not one — the engine cannot call it either, but that is
   * the toolbox's problem to say, not ours to guess at.
   */
  handles(agent: any): boolean {
    const tools: string[] = Array.isArray(agent?.tools) ? agent.tools : [];
    const args = agent?.toolArgs && typeof agent.toolArgs === 'object' ? agent.toolArgs : null;
    return tools.length > 0 && !!args && tools.every((t) => isServiceToolId(t) && args[t] && typeof args[t] === 'object');
  }

  /** Does the task text ask for anything beyond the rows as fetched? */
  wantsShaping(prompt?: string | null): boolean {
    const p = norm(prompt || '');
    return !!p && p.replace(/[.!]$/, '') !== norm(KEEP_AS_FETCHED).replace(/[.!]$/, '');
  }

  /** Run one Social agent job to the end. Never throws — every road finishes the run honestly. */
  async run(runId: string, agent: any, opts: { title?: string } = {}): Promise<void> {
    const title = opts.title || agent?.name || 'Social agent';
    const step = (s: { label: string; status?: string; detail?: string; kind?: string }) => this.agent.appendStep(runId, s).catch(() => undefined);
    const fail = async (error: string) => {
      await step({ label: error, status: 'failed' });
      await this.agent.finishRun(runId, { status: 'failed', error }).catch(() => undefined);
      await this.push?.send?.({ title: `${title} failed`, body: error.slice(0, 140), url: `/agent/runs/${runId}`, tag: `run-${runId}` } as any)?.catch(() => undefined);
      await this.alerts?.runFailed?.(title, error, `/agent/runs/${runId}`)?.catch(() => undefined);
    };

    try {
      await step({ label: 'Fetching directly — no engine turn for this', status: 'done', kind: 'log' });
      const tools: string[] = agent.tools;
      const args: Record<string, any> = agent.toolArgs;

      // ---- 1. fetch — every tool, direct, pinned arguments, credits recorded --------------------
      const fetched: { id: string; r: ServiceRunResult }[] = [];
      let credits = 0;
      for (const id of tools) {
        // The daily credit ceiling (BEA-1358): would THIS call pass it? Then it is not made — the
        // job pauses itself, says why on the run and on its row, and the owner is told.
        let b: BudgetCheck | null = null;
        if (this.budget?.check) {
          try { b = await this.budget.check(id); } catch (e: any) {
            // Fail CLOSED: a guard that cannot answer must not let the call through.
            return fail(`Could not check the daily Social credit ceiling (${String(e?.message || e).slice(0, 120)}) — the call was not made. Try again in a minute.`);
          }
        }
        if (b && !b.ok) {
          await this.budget!.pauseAgent(agent, b.reason!, runId).catch(() => undefined);
          return fail(b.reason!);
        }
        const r = await this.actions.runDetailed(id, '', { runId, runKind: 'agent', agentId: agent.id, args: args[id], argsPinned: true, label: id });
        if (!r.ok) {
          const why = r.outOfCredits ? 'Your Scrape Creators credits are out. Top up, then run it again.' : r.error || 'the fetch failed';
          return fail(`Could not fetch ${r.serviceName || id}: ${why}`);
        }
        credits += Number(r.credits) || 0;
        const t = tableOf(r.data);
        await step({ label: `Fetched ${r.serviceName || ''}${r.actionName ? ` · ${r.actionName}` : ''} — ${t.itemCount} item${t.itemCount === 1 ? '' : 's'} · ${Number(r.credits) || 0} credit${Number(r.credits) === 1 ? '' : 's'}`, status: 'done', detail: JSON.stringify(args[id]).slice(0, 300) });
        fetched.push({ id, r });
      }

      // A Watch / Alert (BEA-1358) says only what changed since last time, then stores the new result.
      const mode = String(agent.mode || 'run');
      if (mode === 'watch' || mode === 'alert') return await this.watch(runId, agent, title, mode, fetched, credits, step, fail);

      // ---- 2. rows — as fetched, or shaped the way the owner asked ----------------------------
      const tables = fetched.map((f) => ({ id: f.id, table: tableOf(f.r.data) }));
      let table = tables.length === 1 ? tables[0].table : mergeTables(tables);
      if (!table.rows.length) return fail('Nothing came back to write — the fetch answered with no items. Check the arguments on the job, or try again later.');

      // Append mode reads the sheet FIRST, so the shaping step can be told the columns it must fit.
      const dest = String(agent.outputDest || 'document');
      let existing: { count: number; header: string[] } | null = null;
      if (dest === 'sheet' && agent.sheetId) {
        const read = await this.readSheet(runId, agent, agent.sheetId);
        if (!read.ok) return fail(read.error!);
        existing = { count: read.count!, header: read.header! };
      }

      if (this.wantsShaping(agent.prompt)) {
        await step({ label: 'Shaping the rows the way you asked', status: 'running', kind: 'log' });
        const shaped = await this.shape(agent.prompt, table, existing?.header?.length ? existing.header : null);
        if (!shaped.ok) return fail(`Could not shape the rows: ${shaped.error}`);
        table = { columns: shaped.columns!, rows: shaped.rows!, itemCount: table.itemCount };
        await step({ label: `Shaped ${shaped.rows!.length} row${shaped.rows!.length === 1 ? '' : 's'} into ${shaped.columns!.length} columns${shaped.note ? ` · ${shaped.note}` : ''}`, status: 'done' });
      }

      // ---- 3. output ----------------------------------------------------------------------------
      let outputUrl: string | undefined;
      let outputDocId: string | undefined;
      let headline: string;
      if (dest === 'sheet') {
        const w = await this.writeSheet(runId, agent, title, table, existing);
        if (!w.ok) return fail(w.error!);
        outputUrl = w.url;
        headline = `${table.rows.length} row${table.rows.length === 1 ? '' : 's'} → ${w.url}`;
        await step({ label: `${w.created ? 'Created a Google Sheet and wrote' : 'Appended'} ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`, status: 'done', detail: w.url });
      } else {
        // document (the default) — the same place every other run's result lands.
        if (!this.documents) return fail('The documents library is not available on this server.');
        const doc: any = await this.documents.create({
          title,
          contentText: `# ${title}\n\n${table.rows.length} rows · ${credits} credit${credits === 1 ? '' : 's'}\n\n${markdownTable(table.columns, table.rows, MAX_ROWS)}`,
          kind: 'md',
          tags: ['agent', 'social'],
          noIndex: true, // outputs stay out of the brain until "Add to my Brain" (BEA-1101)
        } as any);
        outputDocId = doc?.id;
        headline = `${table.rows.length} row${table.rows.length === 1 ? '' : 's'} saved to Documents`;
        if (outputDocId) {
          await this.agent.attachOutput(runId, outputDocId).catch(() => undefined);
          await step({ label: 'Saved to Documents', status: 'done', detail: title });
        }
      }

      const resultText =
        `**${table.rows.length} row${table.rows.length === 1 ? '' : 's'}** · ${credits} credit${credits === 1 ? '' : 's'}` +
        (outputUrl ? ` · [Open the Google Sheet](${outputUrl})` : '') +
        `\n\n${markdownTable(table.columns, table.rows, 10)}`;
      await this.agent.finishRun(runId, { status: 'done', resultText, outputUrl, outputDocId });

      // ---- 4. WhatsApp — the link, through the one path; silence is never an option ------------
      if (agent.notifyWhatsApp) {
        const r = await this.alerts?.runFinished?.(title, headline, `/agent/runs/${runId}`).catch((e: any) => ({ sent: false, why: String(e?.message || e) }));
        await step(whatsappStepLabel(r)); // "WhatsApp sent (template)" / "WhatsApp failed: <reason>" (BEA-1362)
      }
    } catch (e: any) {
      this.log.error(`social run ${runId} crashed: ${e?.message || e}`);
      await fail(String(e?.message || e || 'the run hit a problem'));
    }
  }

  /**
   * The ENGINE road's answer → rows → the sheet (BEA-1357). `HermesBridgeService.driveTurn()` calls
   * this when an ordinary job (a Codex turn, not a direct fetch) has `outputDest:'sheet'`, so the
   * setting is never a dead switch: the report is shaped into the rows the task asks for, written
   * through the same seam, and the run links to the sheet. Throws with a plain reason on any failure
   * — the caller fails the run; nothing here says "done" quietly.
   */
  async deliverTextToSheet(runId: string, agent: any, title: string, text: string): Promise<{ url: string; rows: number; created: boolean }> {
    let existing: { count: number; header: string[] } | null = null;
    if (agent.sheetId) {
      const read = await this.readSheet(runId, agent, agent.sheetId);
      if (!read.ok) throw new Error(read.error);
      existing = { count: read.count!, header: read.header! };
    }
    await this.agent.appendStep(runId, { label: 'Shaping the answer into rows for the sheet', status: 'running', kind: 'log' }).catch(() => undefined);
    const ask = `${String(agent.prompt || '').trim()}\n\nThe text below is the finished answer to that task. Extract the rows it contains — one row per item, fact or finding — into the columns the task asks for (or the most useful ones when it names none).`;
    const shaped = await this.shape(ask, { columns: ['text'], rows: [[text]] }, existing?.header?.length ? existing.header : null);
    if (!shaped.ok || !shaped.rows?.length) throw new Error(`Could not shape the answer into rows: ${shaped.error || 'the shaping model found no rows in it'}`);
    const table = { columns: shaped.columns!, rows: shaped.rows! };
    const w = await this.writeSheet(runId, agent, title, table, existing);
    if (!w.ok) throw new Error(w.error);
    await this.agent.appendStep(runId, { label: `${w.created ? 'Created a Google Sheet and wrote' : 'Appended'} ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`, status: 'done', detail: w.url }).catch(() => undefined);
    return { url: w.url!, rows: table.rows.length, created: !!w.created };
  }

  // ---- watch / alert (BEA-1358) ----------------------------------------------------------------

  /**
   * The Watch/Alert road, after the fetch: diff each tool's answer against its `SocialWatch` row,
   * say ONLY what changed, judge the alert, deliver, and only then store the fresh result as last.
   * Every early return before `save` leaves the last good result untouched.
   */
  private async watch(
    runId: string,
    agent: any,
    title: string,
    mode: string,
    fetched: { id: string; r: ServiceRunResult }[],
    credits: number,
    step: (s: { label: string; status?: string; detail?: string; kind?: string }) => Promise<any>,
    fail: (error: string) => Promise<void>,
  ): Promise<void> {
    if (!this.watches) return fail('Watching is not available on this server (no watch store).');
    const args: Record<string, any> = agent.toolArgs || {};
    const threshold = thresholdOf(agent.threshold);
    const condition = String(agent.alertCondition || '').trim();

    // ---- diff every tool against last time ---------------------------------------------------
    const parts: { id: string; r: ServiceRunResult; row: any; diff: Diff | null }[] = [];
    for (const f of fetched) {
      const row = await this.watches.get(agent.id, f.id, args[f.id]).catch(() => null);
      parts.push({ id: f.id, r: f.r, row, diff: row ? diffResults(row.lastResult, f.r.data, { threshold }) : null });
    }
    const baselines = parts.filter((p) => !p.row);
    const diffs = parts.filter((p) => p.diff) as { id: string; r: ServiceRunResult; row: any; diff: Diff }[];
    const changedDiffs = diffs.filter((p) => p.diff.changed);
    const since = diffs.length ? diffs.map((p) => p.row.lastAt as Date).sort((a, b) => a.getTime() - b.getTime())[0] : null;
    const sinceText = since ? `since ${fmtWhen(since)}` : 'since last time';

    for (const p of baselines) {
      const t = tableOf(p.r.data);
      await step({ label: `Watching from now — baseline stored for ${p.r.actionName || p.id} (${describeBaseline(p.r.data, t.itemCount)})`, status: 'done' });
    }
    for (const p of diffs) await step({ label: `${p.r.actionName || p.id}: ${p.diff.summary}`, status: 'done', kind: 'log' });

    // ---- the alert: a threshold (once-only, no model) and/or a plain-English condition ---------
    let fired = false;
    let why = '';
    let alertNote = '';
    if (mode === 'alert' && changedDiffs.length) {
      const crossed = changedDiffs.map((p) => p.diff.threshold).find((t) => t?.crossed);
      if (crossed) {
        fired = true;
        why = `${fieldLabel(crossed.field)} ${crossed.dir === 'above' ? 'went above' : 'fell below'} ${crossed.value.toLocaleString('en-US')} (${crossed.prev === null ? '—' : crossed.prev.toLocaleString('en-US')} → ${crossed.cur!.toLocaleString('en-US')})`;
      }
      if (!fired && condition) {
        await step({ label: `Judging your condition: “${condition.slice(0, 120)}”`, status: 'running', kind: 'log' });
        const j = await this.judge(condition, changedDiffs.map((p) => p.diff));
        if (!j.ok) return fail(`Could not judge the alert condition: ${j.error}`);
        fired = !!j.fires;
        why = j.why || '';
        alertNote = fired ? '' : `Alert not fired — ${why || 'the condition is not met by this change'}`;
      } else if (!fired && !condition && threshold) {
        const t = changedDiffs.map((p) => p.diff.threshold).find(Boolean);
        alertNote = t?.met ? `Alert not fired — ${fieldLabel(t.field)} is still ${t.dir} ${t.value.toLocaleString('en-US')} (you were told when it crossed)` : `Alert not fired — the threshold was not crossed`;
      } else if (!fired && !condition && !threshold) {
        // an Alert with nothing to judge fires on any change — that is what "alert me" with no
        // condition can only mean
        fired = true;
        why = changedDiffs.map((p) => p.diff.summary).join(' · ');
      }
    }

    // ---- what to say ----------------------------------------------------------------------------
    const summary = changedDiffs.length
      ? changedDiffs.map((p) => `${p.diff.summary} ${sinceText}`).join(' · ')
      : baselines.length && !diffs.length
        ? 'Watching from now — the first result is stored as the baseline; the next run says only what changed.'
        : `Nothing changed ${sinceText}.`;
    const detail = changedDiffs.map((p) => (changedDiffs.length > 1 ? `### ${p.r.actionName || p.id}\n\n` : '') + p.diff.detail).filter(Boolean).join('\n\n');
    const creditsLine = `${credits} credit${credits === 1 ? '' : 's'}`;

    // ---- the push (an Alert that fired) comes FIRST: Telegram, and WhatsApp through the one path.
    // Nothing is written until the owner has been reached — an alert nobody received must not leave a
    // Document behind on every retry.
    if (fired) {
      const text = `${summary}${why ? `\n${why}` : ''}${detail ? `\n\n${detail.replace(/[*`>#|]/g, '').slice(0, 600)}` : ''}`;
      const tg = await this.budget?.pushAlert?.(agent, text, runId).catch((e: any) => ({ sent: false, why: String(e?.message || e) }));
      const wa = await this.alerts?.runFinished?.(`🔔 ${title}`, `${summary}${why ? ` — ${why}` : ''}`, `/agent/runs/${runId}`, { kind: 'alert' }).catch((e: any) => ({ sent: false, why: String(e?.message || e) }));
      const tgSent = !!tg?.sent;
      const waSent = !!wa?.sent;
      await step({ label: tgSent ? 'Alert sent on Telegram' : `⚠️ Not sent on Telegram — ${tg?.why || 'Telegram is not set up'}`, status: tgSent ? 'done' : 'info' });
      await step(whatsappStepLabel(wa)); // template first; the label is the template's own verdict (BEA-1362)
      // An alert nobody received is not a finished alert. Nothing is stored, so it fires again next run.
      if (!tgSent && !waSent) return fail(`The alert fired (${summary}) but could not reach you — Telegram: ${tg?.why || 'not set up'}; WhatsApp: ${wa?.why || 'not set up'}. Link Telegram or add your WhatsApp number in Settings, then run it again.`);
    } else if (alertNote) {
      await step({ label: alertNote, status: 'info' });
    }

    // ---- nothing changed / baseline: no document, no message, store, done ------------------------
    const deliver = mode === 'watch' ? changedDiffs.length > 0 : fired;
    let outputUrl: string | undefined;
    let outputDocId: string | undefined;
    if (deliver) {
      const dest = String(agent.outputDest || 'document');
      const table = diffTable(changedDiffs.map((p) => p.diff), fetched.length > 1 ? changedDiffs.map((p) => p.id) : undefined);
      if (dest === 'sheet' && table.rows.length) {
        let existing: { count: number; header: string[] } | null = null;
        if (agent.sheetId) {
          const read = await this.readSheet(runId, agent, agent.sheetId);
          if (!read.ok) return fail(read.error!);
          existing = { count: read.count!, header: read.header! };
        }
        const w = await this.writeSheet(runId, agent, title, table, existing);
        if (!w.ok) return fail(w.error!);
        outputUrl = w.url;
        await step({ label: `${w.created ? 'Created a Google Sheet and wrote' : 'Appended'} ${table.rows.length} row${table.rows.length === 1 ? '' : 's'} — only what changed`, status: 'done', detail: w.url });
      } else {
        if (!this.documents) return fail('The documents library is not available on this server.');
        const doc: any = await this.documents.create({
          title: `${title} — ${summary.slice(0, 80)}`,
          contentText: `# ${title}\n\n${fired ? '🔔 **Alert fired** — ' : ''}${summary}${why ? `\n\n_${why}_` : ''}\n\n${detail}\n\n_${creditsLine}_`,
          kind: 'md',
          tags: ['agent', 'social', mode],
          noIndex: true, // outputs stay out of the brain until "Add to my Brain" (BEA-1101)
        } as any);
        outputDocId = doc?.id;
        if (outputDocId) {
          await this.agent.attachOutput(runId, outputDocId).catch(() => undefined);
          await step({ label: 'Saved what changed to Documents', status: 'done', detail: title });
        }
      }
    }

    // ---- store the fresh result as "last" — only now, when every step above succeeded ------------
    for (const p of parts) {
      const t = p.diff?.threshold;
      const state = t ? (t.met ? 'met' : 'unmet') : undefined;
      await this.watches.save(agent.id, p.id, args[p.id], p.r.data, { state, alertedAt: fired ? new Date() : undefined });
    }
    if (baselines.length && !diffs.length) await step({ label: 'Baseline stored — nothing is "new" on a first run', status: 'done', kind: 'log' });

    const resultText =
      (fired ? `🔔 **Alert fired** — ` : mode === 'alert' && changedDiffs.length ? `**Alert not fired** — ` : '**') +
      `${summary}${fired || (mode === 'alert' && changedDiffs.length) ? '' : '**'}` +
      (why ? `\n\n_${why}_` : '') +
      (outputUrl ? `\n\n[Open the Google Sheet](${outputUrl})` : '') +
      (detail ? `\n\n${detail}` : '') +
      `\n\n_${creditsLine}_`;
    await this.agent.finishRun(runId, { status: 'done', resultText, outputUrl, outputDocId });

    // A Watch that found something goes out on WhatsApp like any finished job, when the job asks.
    if (mode === 'watch' && changedDiffs.length && agent.notifyWhatsApp) {
      const r = await this.alerts?.runFinished?.(title, summary, `/agent/runs/${runId}`).catch((e: any) => ({ sent: false, why: String(e?.message || e) }));
      await step(whatsappStepLabel(r));
    }
  }

  /**
   * ONE `social-alert` helper call: is the owner's plain-English condition met by what changed?
   * The model sees only the diff (never the whole answer) and answers JSON. No model chosen /
   * nothing back / not JSON → `ok:false`, and the caller fails the run rather than guessing.
   */
  private async judge(condition: string, diffs: Diff[]): Promise<{ ok: boolean; fires?: boolean; why?: string; error?: string }> {
    const items = diffs.flatMap((d) => (d.newItems || []).slice(0, 40).map((it) => flatten(it)));
    let itemsJson = JSON.stringify(items);
    if (itemsJson.length > 20_000) itemsJson = itemsJson.slice(0, 20_000) + '…]';
    const p =
      `You judge whether a plain-English alert condition is met by what changed in a social-media watch.\n\n` +
      `The owner's condition:\n"${condition.slice(0, 500)}"\n\n` +
      `What changed since the last check:\n${diffs.map((d) => `- ${d.summary}`).join('\n')}\n\n` +
      (diffs.some((d) => d.detail) ? `Details:\n${diffs.map((d) => d.detail).join('\n\n').slice(0, 6000)}\n\n` : '') +
      (items.length ? `The new items (JSON, flattened):\n${itemsJson}\n\n` : '') +
      `Rules: answer true ONLY when the change above makes the condition true now; read captions and numbers as they are; never invent facts; when the condition talks about something the change does not mention, answer false.\n` +
      `Reply with ONLY JSON: {"fires": true|false, "why": "one short plain sentence"}`;
    let text: string | null;
    try {
      text = await this.llm.completeHelper('social-alert', p, 300, 'social-alert');
    } catch (e: any) {
      return { ok: false, error: `the alert model could not be reached — ${String(e?.message || e).slice(0, 120)}` };
    }
    if (!text) return { ok: false, error: 'the alert model returned nothing (is a model chosen for "Social alert model" in Settings?)' };
    const m = text.match(/\{[\s\S]*\}/);
    let parsed: any = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
    if (!parsed || typeof parsed.fires !== 'boolean') return { ok: false, error: 'the alert model did not answer yes or no (its reply was not the JSON asked for)' };
    return { ok: true, fires: parsed.fires, why: String(parsed.why || '').slice(0, 300) };
  }

  // ---- the sheet -----------------------------------------------------------------------------

  /** Where to append: how many rows the sheet holds, and its header row (empty on a fresh sheet). */
  private async readSheet(runId: string, agent: any, sheetId: string): Promise<{ ok: boolean; count?: number; header?: string[]; error?: string }> {
    const r = await this.actions.runDetailed(SHEET_READ, '', { runId, runKind: 'agent', agentId: agent.id, argsPinned: true, label: 'Read the sheet', args: { spreadsheet_id: sheetId, ranges: [`${SHEET_TAB}!A:A`, `${SHEET_TAB}!1:1`] } });
    if (!r.ok) return { ok: false, error: this.sheetsError(r) };
    const grids = valuesGrids(r.data);
    const colA = grids[0] || [];
    const header = (grids[1]?.[0] || []).map((c: any) => String(c ?? ''));
    return { ok: true, count: colA.length, header: header.some((h: string) => h.trim()) ? header : [] };
  }

  /** Create + write, or append. Every call is a `ToolCall` row on this run. */
  private async writeSheet(runId: string, agent: any, title: string, table: { columns: string[]; rows: any[][] }, existing: { count: number; header: string[] } | null): Promise<{ ok: boolean; url?: string; id?: string; created?: boolean; error?: string }> {
    let id: string | null = agent.sheetId || null;
    let created = false;
    if (!id) {
      const c = await this.actions.runDetailed(SHEET_CREATE, '', { runId, runKind: 'agent', agentId: agent.id, argsPinned: true, label: 'Create a Google Sheet', args: { title: `${title} — ${new Date().toISOString().slice(0, 10)}` } });
      if (!c.ok) return { ok: false, error: this.sheetsError(c) };
      id = spreadsheetIdOf(c.data);
      if (!id) return { ok: false, error: 'Google Sheets created the sheet but did not say which — no spreadsheet id came back.' };
      created = true;
    }
    // A fresh sheet, or an existing one that is still empty: header + rows from A1. An existing
    // sheet with a header: our rows re-ordered under ITS columns, from the first free row.
    const hasHeader = !!existing && existing.header.length > 0;
    const values = hasHeader ? remap(table, existing!.header) : [table.columns, ...table.rows.map((r) => r.map(cell))];
    const startRow = existing && existing.count > 0 ? existing.count + 1 : 1;
    const w = await this.actions.runDetailed(SHEET_WRITE, '', { runId, runKind: 'agent', agentId: agent.id, argsPinned: true, label: 'Write the rows', args: { spreadsheet_id: id, sheet_name: SHEET_TAB, values, first_cell_location: `A${startRow}` } });
    if (!w.ok) return { ok: false, error: this.sheetsError(w) };
    return { ok: true, id, url: sheetUrl(id), created };
  }

  /** The plain sentence for a Sheets failure. Not connected → "connect Google Sheets first" + where. */
  private sheetsError(r: ServiceRunResult): string {
    const e = String(r.error || 'Google Sheets could not do that.');
    if (/^connect .* first/i.test(e) || /login is not finished/i.test(e)) return 'Connect Google Sheets first — open /tools, connect Google Sheets, then run this job again.';
    return e;
  }

  // ---- the shaping step ----------------------------------------------------------------------

  /**
   * The rows as the owner asked for them — named columns, a filter ("in India"), both. Sonnet-class
   * through `completeHelper('social-shape')`, never a bare `complete()`. Batched so a 400-item fetch
   * is not one 200k-character prompt; the first batch (or the sheet's own header) decides the
   * columns, later batches fill them. Recall over precision: when unsure, keep the item.
   */
  private async shape(prompt: string, table: { columns: string[]; rows: any[][] }, header: string[] | null): Promise<{ ok: boolean; columns?: string[]; rows?: any[][]; note?: string; error?: string }> {
    const items = table.rows.map((r) => Object.fromEntries(table.columns.map((c, i) => [c, r[i]]).filter(([, v]) => v !== '' && v !== null && v !== undefined)));
    const batches: any[][] = [];
    for (let i = 0; i < items.length && batches.length < SHAPE_MAX_BATCHES; i += SHAPE_BATCH) batches.push(items.slice(i, i + SHAPE_BATCH));
    let columns: string[] | null = header && header.length ? header : null;
    const rows: any[][] = [];
    for (const [bi, batch] of batches.entries()) {
      const out = await this.shapeBatch(prompt, batch, columns, bi + 1, batches.length);
      if (!out.ok) return out;
      if (!columns) columns = out.columns!;
      rows.push(...out.rows!.map((r) => columns!.map((_, i) => cell(r[i]))));
    }
    const shown = batches.reduce((n, b) => n + b.length, 0);
    const note = shown < items.length ? `shaped the first ${shown} of ${items.length} items` : undefined;
    return { ok: true, columns: columns || [], rows, note };
  }

  private async shapeBatch(prompt: string, batch: any[], columns: string[] | null, n: number, of: number): Promise<{ ok: boolean; columns?: string[]; rows?: any[][]; error?: string }> {
    let json = JSON.stringify(batch);
    if (json.length > SHAPE_INPUT_CHARS) json = json.slice(0, SHAPE_INPUT_CHARS) + '…]';
    const cols = columns
      ? `Use EXACTLY these columns, in this order (the sheet already has them): ${JSON.stringify(columns)}.`
      : 'Choose short, plain column names that fit what the owner asked for; always include a link column when items have URLs.';
    const p =
      `You turn fetched social-media items into spreadsheet rows.\n\n` +
      `The owner's instructions:\n${String(prompt).slice(0, 1500)}\n\n` +
      `${cols}\n` +
      `Rules: one row per item; when the owner asks to keep only some items (a place, a topic), keep every item that COULD match — recall over precision, when unsure keep it; ` +
      `never invent a value — leave a cell blank when the item does not say; copy numbers as numbers; dates as ISO; no prose outside the JSON.\n` +
      (of > 1 ? `This is batch ${n} of ${of}.\n` : '') +
      `\nThe items (JSON):\n${json}\n\n` +
      `Reply with ONLY JSON: {"columns":["…"],"rows":[["…"],…]}`;
    let text: string | null;
    try {
      text = await this.llm.completeHelper('social-shape', p, SHAPE_MAX_TOKENS, 'social-shape');
    } catch (e: any) {
      return { ok: false, error: `the shaping model could not be reached — ${String(e?.message || e).slice(0, 120)}` };
    }
    if (!text) return { ok: false, error: 'the shaping model returned nothing (is a model chosen for "Social rows model" in Settings?)' };
    const m = text.match(/\{[\s\S]*\}/);
    let parsed: any = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
    const outCols = Array.isArray(parsed?.columns) ? parsed.columns.map((c: any) => String(c)) : null;
    const outRows = Array.isArray(parsed?.rows) ? parsed.rows.filter((r: any) => Array.isArray(r)) : null;
    if (!outCols || !outRows) return { ok: false, error: 'the shaping model did not answer with rows (its reply was not the JSON asked for)' };
    const finalCols = columns || outCols;
    // When the model was told the columns and still renamed some, keep OUR header and its order.
    const rowsFixed = columns && outCols.join('|') !== columns.join('|')
      ? outRows.map((r: any[]) => columns.map((c) => { const i = outCols.findIndex((x: string) => x.trim().toLowerCase() === c.trim().toLowerCase()); return i === -1 ? '' : r[i]; }))
      : outRows;
    return { ok: true, columns: finalCols, rows: rowsFixed };
  }
}

/** Several tools' tables → one: a `source` column first (which tool each row came from), then the columns unioned. */
export function mergeTables(tables: { id: string; table: { columns: string[]; rows: any[][]; itemCount: number } }[]): { columns: string[]; rows: any[][]; itemCount: number } {
  const columns: string[] = ['source'];
  for (const { table: t } of tables) for (const c of t.columns) if (!columns.includes(c)) columns.push(c);
  const rows: any[][] = [];
  for (const { id, table: t } of tables) {
    const source = id.replace(/^svc:/, '');
    for (const r of t.rows) rows.push(columns.map((c) => { if (c === 'source') return source; const i = t.columns.indexOf(c); return i === -1 ? '' : r[i]; }));
  }
  return { columns, rows: rows.slice(0, MAX_ROWS), itemCount: tables.reduce((n, x) => n + x.table.itemCount, 0) };
}

/** `Agent.threshold` as stored (JSON text) or as shaped (object) → a Threshold, or null when there is none. */
export function thresholdOf(raw: any): Threshold | null {
  let t: any = raw;
  if (typeof raw === 'string') { try { t = JSON.parse(raw); } catch { t = null; } }
  if (!t || typeof t !== 'object') return null;
  const value = Number(t.value);
  if (!Number.isFinite(value)) return null;
  return { field: t.field ? String(t.field).trim() || undefined : undefined, dir: t.dir === 'below' ? 'below' : 'above', value };
}

/** "12 items" · "followers 37,570" — what the baseline holds, in a few words. */
export function describeBaseline(data: any, itemCount: number): string {
  const t = tableOf(data);
  if (t.listKey || itemCount > 1) return `${itemCount} item${itemCount === 1 ? '' : 's'}`;
  const flat = flatten(t.rows.length ? Object.fromEntries(t.columns.map((c, i) => [c, t.rows[0][i]])) : {});
  const main = ['follower_count', 'followers', 'followerCount', 'subscriber_count', 'like_count', 'view_count', 'media_count'].find((k) => typeof flat[k] === 'number');
  if (main) return `${fieldLabel(main)} ${Number(flat[main]).toLocaleString('en-US')}`;
  return itemCount === 1 ? '1 item' : 'the current text';
}

/** The changed parts as sheet rows: new items as rows; moved numbers as what/before/now/change; text as what/was/now. */
export function diffTable(diffs: Diff[], sources?: string[]): { columns: string[]; rows: any[][]; itemCount: number } {
  const at = new Date().toISOString();
  const tables = diffs.map((d, i) => {
    if (d.newItems?.length) return { id: sources?.[i] || 'new items', table: tableOf({ items: d.newItems }) };
    const rows: any[][] = [];
    for (const n of d.numbers || []) rows.push([at, fieldLabel(n.field), n.prev, n.cur, n.delta]);
    for (const t of d.texts || []) rows.push([at, fieldLabel(t.field), t.prev.slice(0, 2000), t.cur.slice(0, 2000), '']);
    if (d.threshold?.crossed) rows.push([at, `${fieldLabel(d.threshold.field)} ${d.threshold.dir} ${d.threshold.value}`, d.threshold.prev ?? '', d.threshold.cur ?? '', 'crossed']);
    return { id: sources?.[i] || 'changes', table: { columns: ['checked_at', 'what', 'before', 'now', 'change'], rows, itemCount: rows.length } };
  }).filter((t) => t.table.rows.length);
  if (!tables.length) return { columns: [], rows: [], itemCount: 0 };
  // One diff → its own table. Several (several tools, or new items AND moved numbers) → the union,
  // with a `source` column saying which is which — nothing a tool found is dropped from the sheet.
  if (tables.length === 1) return { columns: tables[0].table.columns, rows: tables[0].table.rows, itemCount: tables[0].table.itemCount };
  return mergeTables(tables);
}

const fmtWhen = (d: Date) => {
  try { return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return d.toISOString(); }
};
