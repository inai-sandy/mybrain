import { Injectable } from '@nestjs/common';
import { ServiceActionsService, ServiceRunResult } from '../tools/service-actions.service';
import { ToolKnowledgeService } from '../tools/tool-knowledge.service';
import { findList, tableOf } from './rows';
import { ALL_PAGES, PlanBlock, PlanCreators, PlanSource, creatorField, dateFieldOf, dedupeKey, itemDate, nextCursorOf, pageCeiling, pagesText, pagingOf } from './plan';
import { isEmptySearch, itemsOf, nounOf, unrecognisedAnswer } from './source-fetch';

/** The daily-ceiling guard: a reason means the call was NOT made and the job paused itself. */
export type FetchGuard = (actionId: string) => Promise<string | null>;
/** The call context a fetch hands `runDetailed()` — who is running, which run, pinned arguments. */
export type FetchCtx = (id: string, args: Record<string, any>) => any;
/** One readable line on the run screen. */
export type FetchStep = (s: { label: string; status?: string; detail?: string; kind?: string; nodeId?: string }) => Promise<any>;
/**
 * What one source produced: the answer, what it cost, or why it is empty / why the run must stop.
 *
 * `unrecognised` is the BEA-1377 tripwire's verdict (BEA-1391): the calls SUCCEEDED and carried
 * data, and no shape here read a single row out of it. It rides beside `empty` because the run's
 * words are the same either way, but a contract must tell the two apart — a genuinely empty vendor
 * answer is a fine, quiet day; an answer we could not read is our bug and may never write output.
 */
export type FetchOut = { r?: ServiceRunResult; credits: number; empty?: boolean; unrecognised?: boolean; why?: string; stop?: string };
export type FetchOpts = {
  /** " (smarthomeindia)" when several sources share this action (BEA-1374) — so five hashtag steps read as five. */
  hint?: string;
  /**
   * Stamped inside the loops — every page, every creator (BEA-1387 §H). A legitimately slow job
   * (11 pages with vendor backoff, 50 sequential creator calls) must never look like a hang, so the
   * progress line is written by the fetcher itself, not left to whatever a worker remembers to do.
   */
  progress?: (label: string) => any;
};

/**
 * The ONE fetcher (BEA-1387, agent workers 2/10 — `specs/AGENT-WORKERS.md` §B).
 *
 * Paging depends on the know-how cards (`ToolKnowledgeService`) and a worker process has no
 * database, so a worker cannot page for itself: `POST /api/worker/tool` performs the whole paged,
 * de-duped fetch **server-side, in this service**, and `SocialAgentRunService.runPlan()` calls the
 * same functions. Two copies of paging is exactly the failure the workers design exists to prevent
 * — parity between the two roads is by construction here, and only checked by the parity suite.
 *
 * Nothing about the behaviour changed when it moved out of the runner: same calls, same early
 * stops, same step wording, same credits.
 */
@Injectable()
export class SourceFetchService {
  constructor(
    private readonly actions: ServiceActionsService,
    // Optional + LAST — spec files build this positionally with fewer args.
    private readonly knowledge?: ToolKnowledgeService, // the know-how cards: how an action pages, which field is the date (BEA-1369)
  ) {}

  /** A plan block → its answer: a paged source, or find-creators-then-their-posts. */
  async fetchBlock(src: PlanBlock, guard: FetchGuard, ctx: FetchCtx, step: FetchStep, opts: FetchOpts = {}): Promise<FetchOut> {
    return src.kind === 'creators' ? this.fetchCreators(src, guard, ctx, step, opts) : this.fetchSource(src, guard, ctx, step, opts);
  }

  /**
   * One source, up to `pages` pages (BEA-1369): page 1 exactly as before; then the vendor's cursor
   * (or the next page number) with the same arguments, one `ToolCall` per page with its credits,
   * items de-duped on the stable id (`itemKey`), and an early stop when a page is empty, repeats,
   * or the vendor says there is no more. The credit ceiling is checked before EVERY page. A page-1
   * failure is what it always was (empty search → empty source; anything else → the run fails); a
   * later page that fails also fails the run — a run may never say done past a failed step.
   */
  async fetchSource(src: PlanSource, guard: FetchGuard, ctx: FetchCtx, step: FetchStep, opts: FetchOpts = {}): Promise<FetchOut> {
    const hint = opts.hint || '';
    const id = src.actionId;
    const nodeId = `src:${src.id}`;
    const wantsAll = src.pages === ALL_PAGES;
    const ceiling = pageCeiling(src.pages);
    const card = ceiling > 1 ? await this.knowledge?.card?.(id).catch(() => null) : null;
    const seen = new Set<string>();
    const items: any[] = [];
    let listKey = '';
    let credits = 0;
    let first: ServiceRunResult | null = null;
    let pagesFetched = 0;
    let stopNote = '';
    let paging: { param: string; how: 'cursor' | 'page' } | null = null;
    let cursor: any = null;
    for (let p = 1; p <= ceiling; p++) {
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
      // Still moving: the run is stamped once a page, so slow is never mistaken for stuck.
      await progress(opts, `fetching ${r.serviceName || id}${hint} — page ${p}${wantsAll ? ' (going until it runs out)' : ceiling > 1 ? ` of ${ceiling}` : ''}, ${items.length} item${items.length === 1 ? '' : 's'} so far`);
      if (p > 1 && fresh === 0) { stopNote = `page ${p} repeated what page ${p - 1} had`; break; }
      if (p === src.pages) break;
      if (p === 1) {
        paging = pagingOf(card?.paging, src.args, r.data);
        if (!paging) { stopNote = 'this endpoint does not page'; break; }
      }
      if (paging.how === 'cursor') {
        const next = nextCursorOf(r.data, paging.param);
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
    // "Asked for every page" never reads as "stopped early": running out IS the finish line.
    const hitTheBackstop = wantsAll && pagesFetched >= ceiling;
    const note = hitTheBackstop
      ? ` · stopped at ${ceiling} pages — that is our safety limit, so there may be more`
      : !stopNote || (!wantsAll && pagesFetched >= src.pages)
        ? ''
        : /does not page/.test(stopNote)
          ? ` · ${stopNote} (${pagesText(src.pages)} asked)`
          : /everything/.test(stopNote)
            ? ` · ${stopNote}`
            : wantsAll
              ? ` · that was all of them (${stopNote})`
              : ` · stopped early: ${stopNote}`;
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
  async fetchCreators(src: PlanCreators, guard: FetchGuard, ctx: FetchCtx, step: FetchStep, opts: FetchOpts = {}): Promise<FetchOut> {
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
    let singles = 0; // answers that were ONE object (a profile lookup) — one row each (BEA-1377)
    let unrecognised = 0; // succeeded WITH data, but no rows recognised — the tripwire's count
    for (const [ci, cr] of creators.entries()) {
      const stop2 = await guard(thenId);
      if (stop2) return { credits, stop: stop2 };
      const r = await this.actions.runDetailed(thenId, '', ctx(thenId, cr.args));
      credits += Number(r.credits) || 0;
      // 50 sequential creator calls are slow on purpose — stamped one by one, so slow never reads as stuck.
      await progress(opts, `fetching creator ${ci + 1} of ${creators.length} (${cr.who})`);
      if (!r.ok) { failures.push(`${cr.who}: ${(r.error || 'the fetch failed').slice(0, 120)}`); continue; }
      thenName = r.actionName || thenName;
      serviceName = r.serviceName || serviceName;
      const rows = itemsOf(r.data);
      if (rows.length === 1 && !findList(r.data)) singles++;
      else if (!rows.length && unrecognisedAnswer(r.data)) unrecognised++;
      answers.push({ who: cr.who, rows });
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
    // A per-creator action that answers ONE object (a profile lookup) reads as ROWS — "3 profiles
    // fetched · 3 rows", never "3 creators · 0 items" while every call succeeded (BEA-1377).
    const enrich = okCount > 0 && singles === okCount;
    const unit = enrich ? 'row' : 'item';
    const keepNote = cutoff === null || rawCount === 0
      ? `${kept} ${unit}${kept === 1 ? '' : 's'}`
      : dateField
        ? `${kept} kept from the last ${keepDays} day${keepDays === 1 ? '' : 's'} (of ${rawCount})`
        : `${kept} ${unit}${kept === 1 ? '' : 's'} — these carry no date, so all were kept (last ${keepDays} days could not be applied)`;
    const failNote = failures.length ? ` · ${failures.length} failed and ${failures.length === 1 ? 'was' : 'were'} skipped` : '';
    // Partial loss is never silent (review of BEA-1377): SOME creators' answers were read and
    // others carried data no shape here recognised — the step says how many were dropped and whose.
    const bugNote = rawCount && unrecognised ? ` · ${unrecognised} answer${unrecognised === 1 ? '' : 's'} carried data but no rows were recognised — a My Brain bug, not the vendor` : '';
    const noun = /profile/i.test(`${thenId} ${thenName}`) ? 'profile' : 'answer';
    const label = enrich
      ? `${okCount} ${noun}${okCount === 1 ? '' : 's'} fetched${failNote} · ${keepNote} · ${credits} credit${credits === 1 ? '' : 's'}${bugNote}`
      : `${creators.length} creator${creators.length === 1 ? '' : 's'} · fetched ${thenName ? thenName.toLowerCase() : 'items'} for ${okCount}${failNote} · ${keepNote} · ${credits} credit${credits === 1 ? '' : 's'}${bugNote}`;
    if (!okCount) {
      await step({ label: `${label} — no creator's fetch succeeded`, status: 'done', detail: failures.join('\n').slice(0, 1200), nodeId });
      return { credits, empty: true, why: `${creators.length} creators found but no creator's fetch succeeded` };
    }
    // The tripwire (BEA-1377): calls succeeded and carried data, yet no shape here recognised a
    // single row. That is OUR bug — say so plainly and finish honestly, never "0 items" as if the
    // vendor had nothing. This line is what would have caught the 101-credit run on day one.
    if (!rawCount && unrecognised) {
      const bug = `fetched ${okCount} answer${okCount === 1 ? '' : 's'} but recognised 0 rows — this is a My Brain bug, not the vendor`;
      await step({ label: `${creators.length} creator${creators.length === 1 ? '' : 's'} · ${bug} · ${credits} credit${credits === 1 ? '' : 's'}`, status: 'done', detail: JSON.stringify(src.find.args).slice(0, 300), nodeId });
      // `unrecognised` marks it as OUR bug for the contract check (BEA-1391 §E): the run's words are
      // the same, but a worker may never treat this as "the vendor had nothing" and write anyway.
      return { credits, empty: true, unrecognised: true, why: bug };
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
}

/** A checkpoint never fails a fetch: a progress line that cannot be written is not a reason to stop. */
async function progress(opts: FetchOpts, label: string): Promise<void> {
  try { await opts.progress?.(label); } catch { /* progress is best-effort */ }
}
