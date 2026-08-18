import { Injectable, Logger } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { DocumentsService } from '../documents/documents.service';
import { LlmService } from '../llm/llm.service';
import { AlertsService } from '../push/alerts.service';
import { whatsappStepLabel } from '../contacts/owner-alert';
import { PushService } from '../push/push.service';
import { ServiceActionsService, ServiceRunResult } from '../tools/service-actions.service';
import { ToolKnowledgeService } from '../tools/tool-knowledge.service';
import { Diff, KEY_FIELDS, diffResults, isVolatileUrl, label as fieldLabel } from './diff';
import { LIST_KEYS, findList, markdownTable, remap, sheetUrl, spreadsheetIdOf, tableOf, valuesGrids, cell, flatten, MAX_ROWS } from './rows';
import { AgentPlan, PlanCreators, PlanSource, creatorField, dateFieldOf, dedupeKey, itemDate, nextCursorOf, pagingOf, planFromAgent, sourceActionId, sourceHint, sourceLabel, thresholdOf } from './plan';
import { BudgetCheck, SocialBudgetService } from './social-budget.service';
import { SocialWatchStore } from './social-watch.store';
import { KEEP_AS_FETCHED, isDirectFetchAgent, wantsShaping } from './social-flow';

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

/** The task text the builder pre-fills — lives in `social-flow.ts` with the picture builder (BEA-1366); re-exported so imports keep working. */
export { KEEP_AS_FETCHED };
/** `Agent.threshold` → a Threshold — lives in `plan.ts` since BEA-1369; re-exported so imports keep working. */
export { thresholdOf };

/**
 * How many items one shaping call is shown, and how many calls a run may make. 30 a batch: the
 * first live 5-page run (60 items, BEA-1369) came back cut off at a 12k-token ceiling — 60 rows ×
 * 9 columns of captions is more JSON than that — so batches are smaller AND the ceiling is higher,
 * and a reply that still gets cut is salvaged row by row (`salvageRowsJson`).
 */
export const SHAPE_BATCH = 30;
const SHAPE_MAX_BATCHES = 16;
const SHAPE_INPUT_CHARS = 60_000;
export const SHAPE_MAX_TOKENS = 32_000;
/** One shaping call may take a while (60 items → rows on a Sonnet-class model); the one-turn 60s default cut a 12-item batch off (BEA-1359). */
const SHAPE_TIMEOUT_MS = 180_000;
/** The longest a single cell shown to the shaping model may be — a caption is read, not a novel. */
const SHAPE_CELL_CHARS = 700;

/** The Sheets actions this uses — the seam ids, never a vendor's name (verified live 2026-08-17). */
export const SHEET_CREATE = 'svc:googlesheets.create_google_sheet1';
export const SHEET_WRITE = 'svc:googlesheets.batch_update';
export const SHEET_READ = 'svc:googlesheets.batch_get';
const SHEET_TAB = 'Sheet1';


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
    private readonly knowledge?: ToolKnowledgeService, // the know-how cards: how an action pages, which field is the date (BEA-1369)
  ) {}

  /**
   * Is this job a direct fetch? Every tool is a `svc:` id AND each has pinned arguments. A job with
   * a bare `svc:` id and no arguments is not one — the engine cannot call it either, but that is
   * the toolbox's problem to say, not ours to guess at.
   */
  handles(agent: any): boolean {
    return isDirectFetchAgent(agent);
  }

  /** Does the task text ask for anything beyond the rows as fetched? (Shared with the flow picture, BEA-1366.) */
  wantsShaping(prompt?: string | null): boolean {
    return wantsShaping(prompt);
  }

  /** Run one Social agent job to the end. Never throws — every road finishes the run honestly. */
  async run(runId: string, agent: any, opts: { title?: string } = {}): Promise<void> {
    return this.runPlan(runId, agent, planFromAgent(agent), opts);
  }

  /**
   * Execute a plan (BEA-1369) — the same steps `run()` always did, read off the plan JSON instead
   * of the raw fields: every source block (a paged source, or find-creators-then-their-posts),
   * merge, shape, watch/alert, write, notify. `run()` is `runPlan(planFromAgent(agent))`, and the
   * flow picture is drawn from the same plan.
   */
  async runPlan(runId: string, agent: any, plan: AgentPlan, opts: { title?: string } = {}): Promise<void> {
    const title = opts.title || plan.name || agent?.name || 'Social agent';
    // `nodeId` names the step's node on the job's drawn flow (BEA-1366: `social-flow.ts` ids —
    // `src:<svc id>`, `merge`, `shape`, `watch`, `write`, `notify`) so the picture can badge what happened.
    const step = (s: { label: string; status?: string; detail?: string; kind?: string; nodeId?: string }) => this.agent.appendStep(runId, s).catch(() => undefined);
    const fail = async (error: string) => {
      await step({ label: error, status: 'failed' });
      await this.agent.finishRun(runId, { status: 'failed', error }).catch(() => undefined);
      await this.push?.send?.({ title: `${title} failed`, body: error.slice(0, 140), url: `/agent/runs/${runId}`, tag: `run-${runId}` } as any)?.catch(() => undefined);
      await this.alerts?.runFailed?.(title, error, `/agent/runs/${runId}`)?.catch(() => undefined);
    };

    try {
      await step({ label: 'Fetching directly — no engine turn for this', status: 'done', kind: 'log' });
      // Sources are keyed by SOURCE id (BEA-1374) — several may call the same action with different
      // arguments. `tools` = each source's action id, in run order.
      const tools: string[] = plan.sources.map((s) => sourceActionId(s));
      // The arguments each source is remembered by (a Watch keys its baseline on them): the plain
      // args of a source (`_pages` left out, so more pages does not forget the baseline), the whole
      // block of a creators-first source.
      const args: Record<string, any> = Object.fromEntries(plan.sources.map((s) => [s.id, s.kind === 'source' ? s.args : { kind: 'creators', find: s.find, then: s.then }]));

      // ---- 1. fetch — every source, direct, pinned arguments, credits recorded --------------------
      // `label` names the source in the merged table's `source` column: the action, plus its telling
      // argument when several sources share one action ("instagram.search_hashtag · smarthomeindia").
      const fetched: { id: string; actionId: string; label: string; hint: string; r: ServiceRunResult }[] = [];
      // Searches the vendor answered "not_found" for (BEA-1359) — empty sources, said on the run,
      // never a failed run: a two-source digest still completes when one search has nothing.
      // Which sources came back empty and WHY — the run's summary must say it per source (BEA-1373).
      const empties: { id: string; label: string; why: string }[] = [];
      let credits = 0;
      // The daily credit ceiling (BEA-1358): would THIS call pass it? Then it is not made — the
      // job pauses itself, says why on the run and on its row, and the owner is told. Checked
      // before EVERY call: each page, the finder, each creator.
      const guard = async (actionId: string): Promise<string | null> => {
        let b: BudgetCheck | null = null;
        if (this.budget?.check) {
          try { b = await this.budget.check(actionId); } catch (e: any) {
            // Fail CLOSED: a guard that cannot answer must not let the call through.
            return `Could not check the daily Social credit ceiling (${String(e?.message || e).slice(0, 120)}) — the call was not made. Try again in a minute.`;
          }
        }
        if (b && !b.ok) {
          await this.budget!.pauseAgent(agent, b.reason!, runId).catch(() => undefined);
          return b.reason!;
        }
        return null;
      };
      const ctx = (id: string, a: Record<string, any>) => ({ runId, runKind: 'agent', agentId: agent.id, args: a, argsPinned: true, label: id });

      for (const src of plan.sources) {
        const out = src.kind === 'creators' ? await this.fetchCreators(src, guard, ctx, step) : await this.fetchSource(src, guard, ctx, step, sourceHint(src, plan.sources));
        if (out.stop) return fail(out.stop);
        credits += out.credits;
        // Fetched fine but nothing kept (a creators block whose posts were all older than the window) is an
        // EMPTY source on a run — said with that reason, never "the vendor answered not_found" (BEA-1373).
        // A Watch/Alert keeps its 0-item table: it diffs against last time and refreshes its baseline.
        if (out.empty || (out.why && plan.mode === 'run')) { empties.push({ id: src.id, label: sourceLabel(src, plan.sources), why: out.why || 'the vendor answered not_found' }); continue; }
        fetched.push({ id: src.id, actionId: sourceActionId(src), label: sourceLabel(src, plan.sources), hint: sourceHint(src, plan.sources), r: out.r! });
      }

      // Every source empty (BEA-1359): the run finishes honestly — 0 found, nothing to write, no
      // sheet made, nothing sent. Not a failure: the calls reached the vendor and it said "nothing".
      const nothingFound = async () => {
        const n = empties.length;
        const allNotFound = empties.every((e) => /not_found/.test(e.why));
        // Every source, with its own reason — a creators block that fetched 50 posts but kept none from
        // the window is NOT "the vendor answered not_found" (the first live run said exactly that, BEA-1373).
        const label = `0 ${nounOf(tools[0])} found — nothing to write, no sheet made${n > 1 ? (allNotFound ? ` (all ${n} sources answered not_found)` : ` (all ${n} sources came back empty)`) : ''}`;
        await step({ label, status: 'done' });
        const why = n === 1
          ? `The source came back empty — ${empties[0].label}: ${empties[0].why}`
          : allNotFound && !plan.sources.some((s) => s.kind === 'creators')
            ? `The vendor answered not_found for every one of the ${n} searches`
            : `Every one of the ${n} sources came back empty:\n${empties.map((e) => `- ${e.label} — ${e.why}`).join('\n')}\n`;
        await this.agent.finishRun(runId, { status: 'done', resultText: `**${label}.**\n\n${why} — nothing to write, no sheet made, nothing sent${plan.notify.whatsapp ? ' (WhatsApp skipped — nothing to send)' : ''}. ${credits} credit${credits === 1 ? '' : 's'}.` });
      };
      if (!fetched.length) return await nothingFound();

      // A Watch / Alert (BEA-1358) says only what changed since last time, then stores the new result.
      const mode = plan.mode;
      if (mode === 'watch' || mode === 'alert') return await this.watch(runId, agent, title, mode, fetched, credits, step, fail, args);

      // ---- 2. rows — as fetched, or shaped the way the owner asked ----------------------------
      const tables = fetched.map((f) => ({ id: f.label, table: tableOf(f.r.data) }));
      let table: { columns: string[]; rows: any[][]; itemCount: number; dedupe?: { column: string; dropped: number } } = tables.length === 1 ? tables[0].table : mergeTables(tables);
      if (tables.length > 1) {
        const d = table.dedupe;
        const dup = d ? (d.dropped ? ` · ${d.dropped} duplicate${d.dropped === 1 ? '' : 's'} across sources dropped (matched on "${d.column}")` : ` · de-duped on "${d.column}" — no duplicates across sources`) : '';
        await step({ label: `Merged ${tables.length} sources into ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}${dup}`, status: 'done', kind: 'log', nodeId: 'merge' });
      }
      if (!table.rows.length) {
        if (empties.length) return await nothingFound();
        return fail('Nothing came back to write — the fetch answered with no items. Check the arguments on the job, or try again later.');
      }

      // Append mode reads the sheet FIRST, so the shaping step can be told the columns it must fit.
      const dest = plan.output.kind;
      let existing: SheetState | null = null;
      if (dest === 'sheet' && plan.output.sheetId) {
        const read = await this.readSheet(runId, agent, plan.output.sheetId, { keys: true });
        if (!read.ok) return fail(read.error!);
        existing = { count: read.count!, header: read.header!, keyed: read.keyed };
      }

      let aiTokens = 0; // what the shaping step really spent — said on the run beside the credits (BEA-1373)
      if (plan.shape) {
        const shapeStart = new Date();
        await step({ label: 'Shaping the rows the way you asked', status: 'running', kind: 'log', nodeId: 'shape' });
        const shaped = await this.shape(plan.shape.prompt, table, existing?.header?.length ? existing.header : null);
        try { aiTokens = (await this.llm.tokensSince?.('social-shape', shapeStart)) || 0; } catch { aiTokens = 0; }
        if (!shaped.ok) { await step({ label: `Could not shape the rows: ${shaped.error}`, status: 'failed', nodeId: 'shape' }); return fail(`Could not shape the rows: ${shaped.error}`); }
        table = { columns: shaped.columns!, rows: shaped.rows!, itemCount: table.itemCount };
        await step({ label: `Shaped ${shaped.rows!.length} row${shaped.rows!.length === 1 ? '' : 's'} into ${shaped.columns!.length} columns${shaped.note ? ` · ${shaped.note}` : ''}${aiTokens ? ` · ${fmtTokens(aiTokens)} AI tokens` : ''}`, status: 'done', nodeId: 'shape' });
      }

      // ---- 3. output ----------------------------------------------------------------------------
      let outputUrl: string | undefined;
      let outputDocId: string | undefined;
      let headline: string;
      if (dest === 'sheet') {
        // "Keep adding" (BEA-1374): rows already in the sheet — same value in its key column (id,
        // shortcode, url…) — are not appended again. The sheet's own column decides, not a model.
        let skipped = 0;
        if (existing?.keyed) {
          const d = dropSeenRows(table, existing.keyed);
          skipped = d.skipped;
          table = d.table;
        }
        if (skipped && !table.rows.length) {
          const url = sheetUrl(plan.output.sheetId!);
          const label = `Nothing new — all ${skipped} row${skipped === 1 ? ' is' : 's are'} already in the sheet (matched on "${existing!.keyed!.column}")`;
          await step({ label, status: 'done', detail: url, nodeId: 'write' });
          await this.agent.finishRun(runId, { status: 'done', resultText: `**${label}.** · ${credits} credit${credits === 1 ? '' : 's'} · [Open the Google Sheet](${url})${plan.notify.whatsapp ? '\n\nWhatsApp skipped — nothing new to send.' : ''}`, outputUrl: url });
          return;
        }
        const w = await this.writeSheet(runId, agent, title, table, existing, { oneSheet: plan.output.append });
        if (!w.ok) { await step({ label: w.error!, status: 'failed', nodeId: 'write' }); return fail(w.error!); }
        outputUrl = w.url;
        headline = `${table.rows.length} row${table.rows.length === 1 ? '' : 's'} → ${w.url}`;
        const dedupe = skipped ? ` (${skipped} already in the sheet — skipped, matched on "${existing!.keyed!.column}")` : '';
        await step({ label: `${w.created ? 'Created a Google Sheet and wrote' : 'Appended'} ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}${dedupe}`, status: 'done', detail: w.url, nodeId: 'write' });
        // "Keep adding" and this was the first run: remember the sheet ON THE JOB, so every later run
        // appends to this one. Not remembered = the next run would make another sheet, which is not
        // what the owner asked — so a failure here fails the run, plainly.
        if (w.created && plan.output.append && w.id) {
          try {
            await this.agent.updateAgent(agent.id, { sheetId: w.id } as any);
            await step({ label: 'Remembered this sheet on the job — the next runs add to it', status: 'done', kind: 'log', nodeId: 'write' });
          } catch (e: any) {
            return fail(`The rows were written to ${w.url}, but the sheet could not be remembered on the job (${String(e?.message || e).slice(0, 160)}) — paste its link into "Append to one sheet" in the job's Settings, or the next run makes another sheet.`);
          }
        }
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
          await step({ label: 'Saved to Documents', status: 'done', detail: title, nodeId: 'write' });
        }
      }

      const resultText =
        `**${table.rows.length} row${table.rows.length === 1 ? '' : 's'}** · ${credits} credit${credits === 1 ? '' : 's'}${aiTokens ? ` · ${fmtTokens(aiTokens)} AI tokens` : ''}` +
        (outputUrl ? ` · [Open the Google Sheet](${outputUrl})` : '') +
        `\n\n${markdownTable(table.columns, table.rows, 10)}`;
      await this.agent.finishRun(runId, { status: 'done', resultText, outputUrl, outputDocId });

      // ---- 4. WhatsApp — the link, through the one path; silence is never an option ------------
      if (plan.notify.whatsapp) {
        const r = await this.alerts?.runFinished?.(title, headline, `/agent/runs/${runId}`).catch((e: any) => ({ sent: false, why: String(e?.message || e) }));
        await step({ ...whatsappStepLabel(r), nodeId: 'notify' }); // "WhatsApp sent (template)" / "WhatsApp failed: <reason>" (BEA-1362)
      }
    } catch (e: any) {
      this.log.error(`social run ${runId} crashed: ${e?.message || e}`);
      await fail(String(e?.message || e || 'the run hit a problem'));
    }
  }

  // ---- the source blocks (BEA-1369) ----------------------------------------------------------

  /**
   * One source, up to `pages` pages (BEA-1369): page 1 exactly as before; then the vendor's cursor
   * (or the next page number) with the same arguments, one `ToolCall` per page with its credits,
   * items de-duped on the stable id (`itemKey`), and an early stop when a page is empty, repeats,
   * or the vendor says there is no more. The credit ceiling is checked before EVERY page. A page-1
   * failure is what it always was (empty search → empty source; anything else → the run fails); a
   * later page that fails also fails the run — a run may never say done past a failed step.
   */
  private async fetchSource(
    src: PlanSource,
    guard: (actionId: string) => Promise<string | null>,
    ctx: (id: string, args: Record<string, any>) => any,
    step: (s: { label: string; status?: string; detail?: string; kind?: string; nodeId?: string }) => Promise<any>,
    /** " (smarthomeindia)" when several sources share this action (BEA-1374) — so five hashtag steps read as five. */
    hint = '',
  ): Promise<{ r?: ServiceRunResult; credits: number; empty?: boolean; why?: string; stop?: string }> {
    const id = src.actionId;
    const nodeId = `src:${src.id}`;
    const card = src.pages > 1 ? await this.knowledge?.card?.(id).catch(() => null) : null;
    const seen = new Set<string>();
    const items: any[] = [];
    let listKey = '';
    let credits = 0;
    let first: ServiceRunResult | null = null;
    let pagesFetched = 0;
    let stopNote = '';
    let paging: { param: string; how: 'cursor' | 'page' } | null = null;
    let cursor: any = null;
    for (let p = 1; p <= src.pages; p++) {
      const stop = await guard(id);
      if (stop) return { credits, stop };
      const a = p === 1 ? src.args : { ...src.args, [paging!.param]: cursor };
      const r = await this.actions.runDetailed(id, '', ctx(id, a));
      if (!r.ok && p === 1) {
        if (isEmptySearch(id, r)) {
          await step({ label: `${r.serviceName || id.replace(/^svc:/, '').split('.')[0]} · ${r.actionName || id}${hint} — no ${nounOf(id)} found (vendor answered not_found) · 0 credits`, status: 'done', detail: JSON.stringify(src.args).slice(0, 300), nodeId });
          return { credits, empty: true, why: `no ${nounOf(id)} found (vendor answered not_found)` };
        }
        const why = r.outOfCredits ? 'Your Scrape Creators credits are out. Top up, then run it again.' : r.error || 'the fetch failed';
        await step({ label: `Could not fetch ${r.serviceName || id}: ${why}`, status: 'failed', nodeId });
        return { credits, stop: `Could not fetch ${r.serviceName || id}: ${why}` };
      }
      if (!r.ok) {
        // A later page the vendor answers not_found for is the end of the list, not a failure —
        // on ANY paged endpoint (page 1 already proved the thing exists), not only a search.
        if (r.notFound) { stopNote = `page ${p} was empty`; break; }
        const why = r.outOfCredits ? 'Your Scrape Creators credits are out. Top up, then run it again.' : r.error || 'the fetch failed';
        await step({ label: `Could not fetch page ${p} of ${r.serviceName || id}: ${why}`, status: 'failed', nodeId });
        return { credits, stop: `Could not fetch page ${p} of ${r.serviceName || id}: ${why} (${items.length} item${items.length === 1 ? '' : 's'} from ${p - 1} page${p - 1 === 1 ? '' : 's'} were not written — nothing is written on a failed run)` };
      }
      credits += Number(r.credits) || 0;
      pagesFetched = p;
      if (p === 1) first = r;
      const list = findList(r.data);
      if (!list) {
        // Not a list (a profile, a transcript): there is nothing to page. Page 1 is the answer.
        if (p > 1) stopNote = `page ${p} had no list`;
        break;
      }
      if (p === 1) listKey = list.key.split('.').pop() || 'items';
      let fresh = 0;
      for (const it of list.rows) { const k = dedupeKey(it); if (seen.has(k)) continue; seen.add(k); items.push(it); fresh++; }
      if (p > 1 && fresh === 0) { stopNote = `page ${p} repeated what page ${p - 1} had`; break; }
      if (p === src.pages) break;
      if (p === 1) {
        paging = pagingOf(card?.paging, src.args, r.data);
        if (!paging) { stopNote = 'this endpoint does not page'; break; }
      }
      if (paging.how === 'cursor') {
        const next = nextCursorOf(r.data);
        if (!next) { stopNote = `that was everything after ${p} page${p === 1 ? '' : 's'}`; break; }
        cursor = next.value;
      } else {
        cursor = (Number(a[paging.param]) || 1) + 1;
      }
    }
    const single = pagesFetched <= 1;
    const count = single ? tableOf(first!.data).itemCount : items.length;
    const over = single ? '' : ` over ${pagesFetched} page${pagesFetched === 1 ? '' : 's'}`;
    // Why fewer pages than asked, in plain words: the vendor does not page this one · that was
    // everything · an empty / repeated page. Nothing when every page asked for was fetched.
    const note = !stopNote || pagesFetched >= src.pages ? '' : /does not page/.test(stopNote) ? ` · ${stopNote} (${src.pages} pages asked)` : /everything/.test(stopNote) ? ` · ${stopNote}` : ` · stopped early: ${stopNote}`;
    await step({ label: `Fetched ${first!.serviceName || ''}${first!.actionName ? ` · ${first!.actionName}` : ''}${hint} — ${count} item${count === 1 ? '' : 's'}${over} · ${credits} credit${credits === 1 ? '' : 's'}${note}`, status: 'done', detail: JSON.stringify(src.args).slice(0, 300), nodeId });
    // One page: the vendor's whole answer, as always (a profile stays a profile). Several: the
    // de-duped items under the list's own key — the same shape the rows, watch and shaping read.
    const r: ServiceRunResult = single ? first! : { ...first!, data: { [listKey || 'items']: items }, credits };
    return { r, credits };
  }

  /**
   * Find creators, then their posts (BEA-1369): the finder once, the first N creators, then the
   * per-creator action once per creator (`argsFrom` maps a creator field into the argument), items
   * newer than `keepDays` kept when the items carry a date (the know-how card says which field; else
   * the usual names; else everything is kept AND the step says so), merged under a `creator` column,
   * de-duped by id. The ceiling is checked before every call. A creator that fails is said and
   * skipped — one bad handle must not fail 40 good ones; no creator succeeded → the source is empty,
   * with the reasons.
   */
  private async fetchCreators(
    src: PlanCreators,
    guard: (actionId: string) => Promise<string | null>,
    ctx: (id: string, args: Record<string, any>) => any,
    step: (s: { label: string; status?: string; detail?: string; kind?: string; nodeId?: string }) => Promise<any>,
  ): Promise<{ r?: ServiceRunResult; credits: number; empty?: boolean; why?: string; stop?: string }> {
    const nodeId = `src:${src.id}`;
    const findId = src.find.actionId;
    const thenId = src.then.actionId;
    let credits = 0;
    if (!thenId) return { credits, stop: 'This creators-first source has no per-creator action — pick one in the job\'s Settings ("then, for each creator").' };
    const mapping = Object.entries(src.then.argsFrom);
    if (!mapping.length) return { credits, stop: 'This creators-first source does not say which creator field fills the per-creator call (for example handle ← username) — set it in the job\'s Settings.' };

    // ---- 1. the finder, once
    const stop = await guard(findId);
    if (stop) return { credits, stop };
    const f = await this.actions.runDetailed(findId, '', ctx(findId, src.find.args));
    if (!f.ok) {
      if (isEmptySearch(findId, f)) {
        await step({ label: `${f.serviceName || 'Search'} · ${f.actionName || findId} — no creators found (vendor answered not_found) · 0 credits`, status: 'done', detail: JSON.stringify(src.find.args).slice(0, 300), nodeId });
        return { credits, empty: true, why: 'no creators found (vendor answered not_found)' };
      }
      const why = f.outOfCredits ? 'Your Scrape Creators credits are out. Top up, then run it again.' : f.error || 'the fetch failed';
      await step({ label: `Could not find creators (${f.serviceName || findId}): ${why}`, status: 'failed', nodeId });
      return { credits, stop: `Could not find creators (${f.serviceName || findId}): ${why}` };
    }
    credits += Number(f.credits) || 0;
    const found = findList(f.data)?.rows || [];
    if (!found.length) {
      await step({ label: `${f.serviceName || ''}${f.actionName ? ` · ${f.actionName}` : ''} — 0 creators found · ${credits} credit${credits === 1 ? '' : 's'}`, status: 'done', detail: JSON.stringify(src.find.args).slice(0, 300), nodeId });
      return { credits, empty: true, why: '0 creators found' };
    }
    // The first N distinct creators (by the field the per-creator call needs).
    const creators: { c: any; args: Record<string, any>; who: string }[] = [];
    const seenWho = new Set<string>();
    const skippedNoField: string[] = [];
    for (const c of found) {
      if (creators.length >= src.find.take) break;
      const a: Record<string, any> = { ...(src.then.args || {}) };
      let who = '';
      let missing = '';
      for (const [param, field] of mapping) {
        const v = creatorField(c, field);
        if (v === undefined || v === null || v === '') { missing = field; break; }
        a[param] = v;
        if (!who) who = String(v);
      }
      if (missing) { skippedNoField.push(missing); continue; }
      if (seenWho.has(who)) continue;
      seenWho.add(who);
      creators.push({ c, args: a, who });
    }
    await step({ label: `${found.length} creator${found.length === 1 ? '' : 's'} found${creators.length < found.length ? ` · taking the first ${creators.length}` : ''}${skippedNoField.length ? ` (${skippedNoField.length} had no ${skippedNoField[0]})` : ''} · ${credits} credit${credits === 1 ? '' : 's'}`, status: 'done', kind: 'log', detail: JSON.stringify(src.find.args).slice(0, 300), nodeId });
    if (!creators.length) {
      await step({ label: `No creator carried the field the per-creator call needs (${mapping.map(([, fld]) => fld).join(', ')}) — nothing to fetch`, status: 'done', nodeId });
      return { credits, empty: true, why: `no creator carried the field the per-creator call needs (${mapping.map(([, fld]) => fld).join(', ')})` };
    }

    // ---- 2. per creator — fetch them all first, then decide the date field over EVERY item
    const card = await this.knowledge?.card?.(thenId).catch(() => null);
    const failures: string[] = [];
    const answers: { who: string; rows: any[] }[] = [];
    let thenName = '';
    let serviceName = f.serviceName || '';
    for (const cr of creators) {
      const stop2 = await guard(thenId);
      if (stop2) return { credits, stop: stop2 };
      const r = await this.actions.runDetailed(thenId, '', ctx(thenId, cr.args));
      credits += Number(r.credits) || 0;
      if (!r.ok) { failures.push(`${cr.who}: ${(r.error || 'the fetch failed').slice(0, 120)}`); continue; }
      thenName = r.actionName || thenName;
      serviceName = r.serviceName || serviceName;
      answers.push({ who: cr.who, rows: itemsOf(r.data) });
    }
    const okCount = answers.length;
    const rawCount = answers.reduce((n, a) => n + a.rows.length, 0);
    const keepDays = src.then.keepDays;
    const cutoff = keepDays ? Date.now() - keepDays * 24 * 60 * 60 * 1000 : null;
    // Which field is the date — decided over every creator's items together (the card's date field
    // inside the list, else the usual names); an early creator with nothing must not decide "no date".
    const dateField = cutoff !== null ? dateFieldOf(answers.flatMap((a) => a.rows), card?.fields) : null;
    const items: any[] = [];
    const seen = new Set<string>();
    for (const a of answers) {
      for (const it of a.rows) {
        if (cutoff !== null && dateField) { const d = itemDate(it, dateField); if (d !== null && d < cutoff) continue; }
        const k = dedupeKey(it);
        if (seen.has(k)) continue;
        seen.add(k);
        items.push({ creator: a.who, ...it });
      }
    }
    const kept = items.length;
    const keepNote = cutoff === null || rawCount === 0
      ? `${kept} item${kept === 1 ? '' : 's'}`
      : dateField
        ? `${kept} kept from the last ${keepDays} day${keepDays === 1 ? '' : 's'} (of ${rawCount})`
        : `${kept} item${kept === 1 ? '' : 's'} — these carry no date, so all were kept (last ${keepDays} days could not be applied)`;
    const failNote = failures.length ? ` · ${failures.length} failed and ${failures.length === 1 ? 'was' : 'were'} skipped` : '';
    const label = `${creators.length} creator${creators.length === 1 ? '' : 's'} · fetched ${thenName ? thenName.toLowerCase() : 'items'} for ${okCount}${failNote} · ${keepNote} · ${credits} credit${credits === 1 ? '' : 's'}`;
    if (!okCount) {
      await step({ label: `${label} — no creator's fetch succeeded`, status: 'done', detail: failures.join('\n').slice(0, 1200), nodeId });
      return { credits, empty: true, why: `${creators.length} creators found but no creator's fetch succeeded` };
    }
    await step({ label, status: 'done', detail: failures.length ? failures.join('\n').slice(0, 1200) : JSON.stringify(src.find.args).slice(0, 300), nodeId });
    // Fetched fine but nothing kept (every post older than the window, or every account empty): an
    // EMPTY source with that reason — not a not_found, and not a silent 0-row table (BEA-1373).
    // (`why` beside `r`, not `empty`: a Watch still needs the 0-item table to diff and to refresh its
    // baseline — the caller decides by mode.)
    const r: ServiceRunResult = { ok: true, data: { items }, credits, serviceName, actionName: `${f.actionName || 'Find creators'} → ${thenName || 'their posts'}` };
    if (!kept) return { r, credits, why: `${creators.length} creator${creators.length === 1 ? '' : 's'} · ${keepNote}` };
    return { r, credits };
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
    fetched: { id: string; actionId?: string; label?: string; hint?: string; r: ServiceRunResult }[],
    credits: number,
    step: (s: { label: string; status?: string; detail?: string; kind?: string; nodeId?: string }) => Promise<any>,
    fail: (error: string) => Promise<void>,
    /** The arguments each source is remembered by, keyed by SOURCE id — always the plan's, never raw `toolArgs` (BEA-1374: the stored shape is not the plain args). */
    args: Record<string, any>,
  ): Promise<void> {
    if (!this.watches) return fail('Watching is not available on this server (no watch store).');
    const threshold = thresholdOf(agent.threshold);
    const condition = String(agent.alertCondition || '').trim();

    // ---- diff every source against last time -------------------------------------------------
    // A baseline row is keyed by (job, ACTION id, arguments) — the source's action, so a job saved
    // before BEA-1374 (source id = action id) keeps every baseline it had; two sources on one action
    // with different arguments are two rows.
    const parts: { id: string; actionId: string; label: string; r: ServiceRunResult; row: any; diff: Diff | null }[] = [];
    for (const f of fetched) {
      const actionId = f.actionId || f.id;
      const row = await this.watches.get(agent.id, actionId, args[f.id]).catch(() => null);
      parts.push({ id: f.id, actionId, label: f.label || f.id, r: f.r, row, diff: row ? diffResults(row.lastResult, f.r.data, { threshold }) : null });
    }
    // "Search Hashtag Posts (smarthomeindia)" when several sources share one action, else the action's name.
    const hints = new Map(fetched.map((f) => [f.id, f.hint || '']));
    const nameOf = (p: { id: string; r: ServiceRunResult }) => `${p.r.actionName || p.id}${hints.get(p.id) || ''}`;
    const baselines = parts.filter((p) => !p.row);
    const diffs = parts.filter((p) => p.diff) as { id: string; actionId: string; label: string; r: ServiceRunResult; row: any; diff: Diff }[];
    const changedDiffs = diffs.filter((p) => p.diff.changed);
    const since = diffs.length ? diffs.map((p) => p.row.lastAt as Date).sort((a, b) => a.getTime() - b.getTime())[0] : null;
    const sinceText = since ? `since ${fmtWhen(since)}` : 'since last time';

    for (const p of baselines) {
      const t = tableOf(p.r.data);
      await step({ label: `Watching from now — baseline stored for ${nameOf(p)} (${describeBaseline(p.r.data, t.itemCount)})`, status: 'done', nodeId: 'watch' });
    }
    for (const p of diffs) await step({ label: `${nameOf(p)}: ${p.diff.summary}`, status: 'done', kind: 'log', nodeId: 'watch' });

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
    const detail = changedDiffs.map((p) => (changedDiffs.length > 1 ? `### ${nameOf(p)}\n\n` : '') + p.diff.detail).filter(Boolean).join('\n\n');
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
      await step({ label: tgSent ? 'Alert sent on Telegram' : `⚠️ Not sent on Telegram — ${tg?.why || 'Telegram is not set up'}`, status: tgSent ? 'done' : 'info', nodeId: 'notify' });
      await step({ ...whatsappStepLabel(wa), nodeId: 'notify' }); // template first; the label is the template's own verdict (BEA-1362)
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
      const table = diffTable(changedDiffs.map((p) => p.diff), fetched.length > 1 ? changedDiffs.map((p) => p.label) : undefined);
      if (dest === 'sheet' && table.rows.length) {
        let existing: SheetState | null = null;
        if (agent.sheetId) {
          // A Watch already writes only what is new since last time — no key-column read needed here.
          const read = await this.readSheet(runId, agent, agent.sheetId);
          if (!read.ok) return fail(read.error!);
          existing = { count: read.count!, header: read.header! };
        }
        const oneSheet = !!agent.sheetId || !!agent.sheetAppend;
        const w = await this.writeSheet(runId, agent, title, table, existing, { oneSheet });
        if (!w.ok) return fail(w.error!);
        outputUrl = w.url;
        await step({ label: `${w.created ? 'Created a Google Sheet and wrote' : 'Appended'} ${table.rows.length} row${table.rows.length === 1 ? '' : 's'} — only what changed`, status: 'done', detail: w.url, nodeId: 'write' });
        if (w.created && agent.sheetAppend && w.id) {
          try { await this.agent.updateAgent(agent.id, { sheetId: w.id } as any); }
          catch (e: any) { return fail(`The rows were written to ${w.url}, but the sheet could not be remembered on the job (${String(e?.message || e).slice(0, 160)}) — paste its link into "Append to one sheet" in the job's Settings, or the next run makes another sheet.`); }
        }
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
          await step({ label: 'Saved what changed to Documents', status: 'done', detail: title, nodeId: 'write' });
        }
      }
    }

    // ---- store the fresh result as "last" — only now, when every step above succeeded ------------
    for (const p of parts) {
      const t = p.diff?.threshold;
      const state = t ? (t.met ? 'met' : 'unmet') : undefined;
      await this.watches.save(agent.id, p.actionId, args[p.id], p.r.data, { state, alertedAt: fired ? new Date() : undefined });
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
      await step({ ...whatsappStepLabel(r), nodeId: 'notify' });
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

  /**
   * What the sheet holds now: the row count (column A), the header, and — when the header has a key
   * column (`id`, `shortcode`, `url`… — `KEY_FIELDS`) and the sheet has rows — that column's values,
   * so "keep adding" (BEA-1374) can skip rows the sheet already has. One extra read, only then.
   */
  private async readSheet(runId: string, agent: any, sheetId: string, opts: { keys?: boolean } = {}): Promise<{ ok: boolean; count?: number; header?: string[]; keyed?: SheetKey; error?: string }> {
    const r = await this.actions.runDetailed(SHEET_READ, '', { runId, runKind: 'agent', agentId: agent.id, argsPinned: true, label: 'Read the sheet', args: { spreadsheet_id: sheetId, ranges: [`${SHEET_TAB}!A:A`, `${SHEET_TAB}!1:1`] } });
    if (!r.ok) return { ok: false, error: this.sheetsError(r) };
    const grids = valuesGrids(r.data);
    const colA = grids[0] || [];
    const header = (grids[1]?.[0] || []).map((c: any) => String(c ?? ''));
    const out: { ok: boolean; count?: number; header?: string[]; keyed?: SheetKey; error?: string } = { ok: true, count: colA.length, header: header.some((h: string) => h.trim()) ? header : [] };
    const keyAt = opts.keys ? keyColumnIndex(out.header!) : -1;
    if (keyAt >= 0 && colA.length > 1) {
      const col = colLetter(keyAt);
      const k = await this.actions.runDetailed(SHEET_READ, '', { runId, runKind: 'agent', agentId: agent.id, argsPinned: true, label: 'Read the sheet’s key column', args: { spreadsheet_id: sheetId, ranges: [`${SHEET_TAB}!${col}:${col}`] } });
      if (!k.ok) return { ok: false, error: this.sheetsError(k) };
      const values = new Set<string>();
      for (const row of (valuesGrids(k.data)[0] || []).slice(1)) { const v = keyText(row?.[0]); if (v) values.add(v); }
      out.keyed = { column: out.header![keyAt], values };
    }
    return out;
  }

  /** Create + write, or append. Every call is a `ToolCall` row on this run. */
  private async writeSheet(runId: string, agent: any, title: string, table: { columns: string[]; rows: any[][] }, existing: { count: number; header: string[] } | null, opts: { oneSheet?: boolean } = {}): Promise<{ ok: boolean; url?: string; id?: string; created?: boolean; error?: string }> {
    let id: string | null = agent.sheetId || null;
    let created = false;
    if (!id) {
      // A new sheet per run is dated; the ONE sheet a "keep adding" job creates on its first run is not.
      const c = await this.actions.runDetailed(SHEET_CREATE, '', { runId, runKind: 'agent', agentId: agent.id, argsPinned: true, label: 'Create a Google Sheet', args: { title: opts.oneSheet ? title : `${title} — ${new Date().toISOString().slice(0, 10)}` } });
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
    const items = table.rows.map((r) => shapeInput(Object.fromEntries(table.columns.map((c, i) => [c, r[i]]))));
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
      text = await this.llm.completeHelper('social-shape', p, SHAPE_MAX_TOKENS, 'social-shape', { timeoutMs: SHAPE_TIMEOUT_MS });
    } catch (e: any) {
      return { ok: false, error: `the shaping model could not be reached — ${String(e?.message || e).slice(0, 120)}` };
    }
    if (!text) return { ok: false, error: 'the shaping model returned nothing (is a model chosen for "Social rows model" in Settings?)' };
    const parsed = salvageRowsJson(text);
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

/**
 * The `{columns, rows}` inside a shaping reply — whole when it parses, else the complete rows of a
 * reply that was CUT OFF mid-row (a 12k-token ceiling once ate a 60-item batch): the text is cut
 * back to the last row that closed (`],` / `]`), and closed off. Null when nothing usable is there.
 */
export function salvageRowsJson(text: string): { columns?: any; rows?: any } | null {
  const start = String(text || '').indexOf('{');
  if (start === -1) return null;
  const body = String(text).slice(start);
  const tryParse = (t: string) => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  const whole = tryParse(body.slice(0, body.lastIndexOf('}') + 1));
  if (whole && Array.isArray(whole.rows)) return whole;
  // cut back to the last complete row: the last "]" that is followed (after spaces) by "," or "]" or the end
  const rowsAt = body.search(/"rows"\s*:\s*\[/);
  if (rowsAt === -1) return null;
  const head = body.slice(0, rowsAt) + '"rows":[';
  let tail = body.slice(rowsAt + body.slice(rowsAt).indexOf('[') + 1);
  let tries = 0;
  // `cut` walks back over every "]" — each is a candidate end of the last complete row.
  for (let cut = tail.lastIndexOf(']'); cut >= 0 && tries < 2000; cut = tail.lastIndexOf(']', cut - 1), tries++) {
    const v = tryParse(head + tail.slice(0, cut + 1) + ']}');
    if (v && Array.isArray(v.rows)) return v;
    if (cut === 0) break;
  }
  // no row closed at all → the columns alone, with no rows
  const v = tryParse(head + ']}');
  return v && Array.isArray(v.rows) ? v : null;
}

/**
 * One fetched item as the shaping model should see it (BEA-1359): signed CDN links dropped (a
 * `display_url`/`video_url`/`profile_pic_url` with `?oh=…&oe=…` is hundreds of characters, expires
 * in hours and can never be a sheet column — half of a 12-post answer was these), blanks dropped,
 * long text capped. The post's own link (`/p/ABC/`) is not volatile and stays.
 */
export function shapeInput(item: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(item || {})) {
    if (v === '' || v === null || v === undefined) continue;
    if (isVolatileUrl(v)) continue;
    out[k] = typeof v === 'string' && v.length > SHAPE_CELL_CHARS ? v.slice(0, SHAPE_CELL_CHARS) + '…' : v;
  }
  return out;
}

/** 38,412 → "38k"; below 1000 the number itself. */
export function fmtTokens(n: number): string { return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n); }

/**
 * A vendor "not_found" on a SEARCH is an empty source, not a broken one (BEA-1359): Scrape Creators'
 * Google-indexed searches answer `404 not_found` for a query with no posts. A profile or a post
 * lookup that answers not_found still fails the run — that means the thing does not exist.
 */
export function isEmptySearch(id: string, r: ServiceRunResult): boolean {
  if (!r?.notFound) return false;
  const endpoint = String(id || '').replace(/^svc:/, '').split('.')[1] || '';
  return /search/.test(endpoint);
}

/**
 * The items of one per-creator answer: a list → its items; an answer SHAPED like a list with nothing
 * in it (`{items: []}`, `{items: null, user: {…}}`, a private account's `{user, more_available:false}`
 * with a list key present) → nothing, never one row of envelope; a plain object with no list key at
 * all (a profile lookup as the per-creator action) → that one object.
 */
export function itemsOf(data: any): any[] {
  const list = findList(data);
  if (list) return list.rows;
  if (Array.isArray(data)) return [];
  if (!data || typeof data !== 'object') return [];
  const listShaped = Object.keys(data).some((k) => LIST_KEYS.includes(k)) || Object.values(data).some((v) => Array.isArray(v));
  return listShaped ? [] : [data];
}

/** What a search finds, for the run's own words: posts · reels · videos · results. */
export function nounOf(id: string): string {
  const endpoint = String(id || '').replace(/^svc:/, '').split('.')[1] || '';
  if (/reel/.test(endpoint)) return 'reels';
  if (/video/.test(endpoint)) return 'videos';
  if (/post|hashtag|keyword|topic|trend/.test(endpoint)) return 'posts';
  return 'results';
}

/** What `readSheet` learned about an existing sheet: rows, header, and its key column's values when it has one. */
export type SheetKey = { column: string; values: Set<string> };
type SheetState = { count: number; header: string[]; keyed?: SheetKey };

/**
 * Fields that name the OWNER of an item, not the item — `KEY_FIELDS` ranks them for single-item
 * lookups, but for de-duping ROWS across sources / against a sheet they come LAST: two posts by one
 * creator must never be "the same row" while a post id or link is there to tell them apart.
 */
const OWNER_FIELDS = ['uid', 'user_id', 'username'];
export const ROW_KEY_FIELDS = [...KEY_FIELDS.filter((f) => !OWNER_FIELDS.includes(f)), ...OWNER_FIELDS];

/** The header column that identifies a row (`ROW_KEY_FIELDS` order: id, shortcode… url, link; owner fields last), by name, case-blind; -1 = none. */
export function keyColumnIndex(header: string[]): number {
  const names = (header || []).map((h) => String(h ?? '').trim().toLowerCase());
  for (const f of ROW_KEY_FIELDS) { const i = names.indexOf(f.toLowerCase()); if (i >= 0) return i; }
  return -1;
}

/** 0 → A, 25 → Z, 26 → AA. */
export function colLetter(i: number): string {
  let n = Math.max(0, Math.floor(i)) + 1;
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** A key cell as compared: trimmed text; a number is its plain text; blank → ''. */
export function keyText(v: any): string {
  if (v === undefined || v === null) return '';
  return String(typeof v === 'object' ? JSON.stringify(v) : v).trim();
}

/**
 * Drop the rows whose key-column value the sheet already has (BEA-1374 "keep adding"): the table's
 * column of the same name (case-blind), else nothing is dropped — never a guess. Pure.
 */
export function dropSeenRows(table: { columns: string[]; rows: any[][]; itemCount: number }, keyed: SheetKey): { table: { columns: string[]; rows: any[][]; itemCount: number }; skipped: number } {
  const at = (table.columns || []).findIndex((c) => String(c ?? '').trim().toLowerCase() === String(keyed.column ?? '').trim().toLowerCase());
  if (at < 0 || !keyed.values?.size) return { table, skipped: 0 };
  const rows = table.rows.filter((r) => { const v = keyText(r[at]); return !v || !keyed.values.has(v); });
  return { table: { ...table, rows }, skipped: table.rows.length - rows.length };
}

/**
 * Several sources' tables → one: a `source` column first (which source each row came from), then the
 * columns unioned, and — since BEA-1374, when the union has an id column (`KEY_FIELDS`: id, pk,
 * shortcode, url…) — de-duped on it across sources: five hashtag searches that found the same post
 * give ONE row (the first source's). Rows with no id are always kept. `dedupe` says what was dropped.
 */
export function mergeTables(tables: { id: string; table: { columns: string[]; rows: any[][]; itemCount: number } }[]): { columns: string[]; rows: any[][]; itemCount: number; dedupe?: { column: string; dropped: number } } {
  const columns: string[] = ['source'];
  for (const { table: t } of tables) for (const c of t.columns) if (!columns.includes(c)) columns.push(c);
  const keyAt = keyColumnIndex(columns.slice(1)) ; // never `source` itself
  const keyCol = keyAt >= 0 ? columns[keyAt + 1] : '';
  const seen = new Set<string>();
  let dropped = 0;
  const rows: any[][] = [];
  for (const { id, table: t } of tables) {
    const source = id.replace(/^svc:/, '');
    for (const r of t.rows) {
      const row = columns.map((c) => { if (c === 'source') return source; const i = t.columns.indexOf(c); return i === -1 ? '' : r[i]; });
      if (keyCol) {
        const k = keyText(row[keyAt + 1]);
        if (k) { if (seen.has(k)) { dropped++; continue; } seen.add(k); }
      }
      rows.push(row);
    }
  }
  const out: { columns: string[]; rows: any[][]; itemCount: number; dedupe?: { column: string; dropped: number } } = { columns, rows: rows.slice(0, MAX_ROWS), itemCount: tables.reduce((n, x) => n + x.table.itemCount, 0) };
  if (keyCol) out.dedupe = { column: keyCol, dropped };
  return out;
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
