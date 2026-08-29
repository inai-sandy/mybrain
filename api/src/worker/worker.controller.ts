import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AgentService } from '../agent/agent.service';
import { customerWords } from '../agent/failure-words';
import { opsAlertIfPlumbing } from '../push/ops-alert';
import { LlmService } from '../llm/llm.service';
import { AlertsService } from '../push/alerts.service';
import { whatsappStepLabel } from '../contacts/owner-alert';
import { ServiceActionsService } from '../tools/service-actions.service';
import { isReadAction } from '../tools/service-provider';
import { GatePause, ServiceGatesService } from '../tools/service-gates.service';
import { ASK_DEADLINE_HOURS, OwnerAskService } from './owner-ask.service';
import { SocialAgentRunService, SHAPE_MAX_TOKENS, mergeTables } from '../social/social-agent-run.service';
import { SocialBudgetService, BudgetCheck } from '../social/social-budget.service';
import { SourceFetchService } from '../social/source-fetch.service';
import { planFromAgent, sourceHint, sourceLabel, clampPages } from '../social/plan';
import { ReadRecipe, readAnswer, readNote } from '../social/read-recipe';
import { tableOf } from '../social/rows';
import { RAW_MAX } from '../tools/tool-sample';
import { ToolLookupService } from '../tools/tool-lookup.service';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { DeepResearchService } from '../tools/deep-research.service';
import { RunJournalService } from './run-journal.service';
import { WorkerTokenGuard } from './worker-token.guard';
import { TrialService } from './trial.service';
import { WorkerTokenService } from './worker-token.service';

/**
 * The helpers a worker's AI step may use. Anything else is refused — a worker never picks its own
 * model or its own prompt budget, and a helper key that is not registered would fall through to the
 * app's general model (the trap `completeHelper` exists to close).
 */
/**
 * The named models a worker may use. `worker-think` is its own judgement step (BEA-1453) -- the thing
 * a worker could not do before, and the reason "this needs real thinking" routed a whole agent
 * around the brief, the trial and the gate.
 */
export const WORKER_HELPERS = ['social-shape', 'social-alert', 'worker-think'];

/** The most tokens one generic worker AI call may ask for. The shaping mode has its own ceiling. */
const AI_MAX_TOKENS = SHAPE_MAX_TOKENS;

/**
 * How many times a CHECK may auto-answer the same question before it gives up (BEA-1571).
 *
 * Three is enough to let a worker retry a transient thing and few enough that a loop costs almost
 * nothing. It applies only to a trial: a real run parks on a question for as long as the owner
 * takes (BEA-1565), and that is never touched by this.
 */
const TRIAL_ASK_LIMIT = 3;

/**
 * How much of the agent's own message may go out (BEA-1407). WhatsApp's own limit for a free-text
 * body is 4,096 characters; this leaves room and keeps one runaway job from writing an essay.
 */
export const MESSAGE_CHARS = 3500;

/** How many actions one `kit.facts` lookup lists. Enough to choose from, not enough to be a wall. */
export const FACTS_MAX = 40;

/**
 * The worker road runs unguarded (BEA-1471) — the owner's decision, twice stated.
 *
 * A constant rather than a setting: he asked for one behaviour, not a switch, and a switch would be
 * one more place for two roads to disagree. It is named so that anyone reading a runaway later can
 * find this line and the reasoning above `guard()` in one search.
 */
export const UNGUARDED = true;

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
@Controller('worker') // the app prefixes every route with /api (`main.ts`), so this IS /api/worker/*
export class WorkerController {
  /**
   * What a CHECK has already been asked, per run (BEA-1571). In memory on purpose: it only has to
   * outlive one smoke run, which is a single process and a couple of minutes, and a token is
   * revoked the moment that run settles. Cleared when the run finishes.
   */
  private readonly trialAsks = new Map<string, Map<string, number>>();

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
    private readonly owner?: OwnerAskService, // the question's road to the owner's phone (BEA-1392)
    private readonly gates?: ServiceGatesService,
    private readonly trials?: TrialService, // holds a trial's rows and message instead of writing/sending (BEA-1408)
    private readonly lookup?: ToolLookupService, // what exists, for `kit.facts` (BEA-1457)
    // Named `research_` because the ROUTE is called `research` and a method may not shadow a field.
    private readonly research_?: DeepResearchService, // `kit.research` (BEA-1458)
    private readonly catalog?: ToolCatalogService, // read-or-write, for the trial guard (BEA-1471)
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
    // A can't-undo call parks the run and asks the owner (§H) instead of failing it — this is the
    // one route where an arbitrary `svc:` action can be reached, so it is the one that can gate.
    return this.saying(() => this.fetch(req, body), { req, body });
  }

  private async fetch(req: any, body: any) {
    const { runId, agentId, trial } = who(req);
    const seq = seqOf(body);
    const job = await this.job(agentId);
    const step = this.stepper(runId);
    const progress = (label: string) => this.agent.stampProgress?.(runId, label);

    // PAGING FOR A GOAL-BUILT PROGRAM (BEA-1495).
    //
    // His ESP32 agent asked Reddit for the top 100 posts of the week, got 6, and stopped. The answer
    // it received carried `after: "t3_1vz262m"` — the cursor to the next page — and the tool document
    // said "paging: cursor via after" in plain words. It had every fact and made one call anyway.
    //
    // The cause is not judgement. The Social road has done paging for this exact tool for months —
    // follow the cursor, de-dupe on the item id, stop early on a repeat or an empty page, count the
    // credits — and a goal-built program could not reach a line of it, because that code is only
    // reachable through a PLAN SOURCE and a goal agent has no plan. So every agent was left to
    // re-derive paging from scratch, per service, and this one did not.
    //
    // A synthetic source carries the arbitrary action into the SAME fetcher. No second paging
    // implementation exists, which is the only way these two roads can keep agreeing.
    if (body?.actionId && (body?.pages !== undefined || body?.until !== undefined)) {
      const actionId = String(body.actionId);
      const src: any = {
        kind: 'source',
        id: actionId,
        actionId,
        args: body?.args && typeof body.args === 'object' ? body.args : {},
        // A TRIAL FETCHES ONE PAGE (BEA-1552). Trial mode already holds every write and send, but the
        // READS were full price — his ESP32 worker asks for `pages: 'all'` and really fetches 35. A
        // smoke run before promotion must cost about what one look costs, or nobody will keep it on.
        //
        // Clamped HERE, from the token, for the same reason the write-hold is: a worker must not be
        // able to talk its way out of it. One page is enough to learn what a smoke run is for — does
        // it run, does it parse the answer, does it produce rows.
        pages: trial ? 1 : clampPages(body.pages ?? 11),
      };
      const args = { actionId, args: src.args, pages: src.pages };
      const hit = await this.journal.once(runId, seq, 'fetchPaged', args, async () => {
        const out = await this.sources.fetchBlock(src, this.guard(runId, job, seq), this.ctx(runId, job, seq), step, { progress });
        return {
          ok: !out.stop,
          actionId,
          credits: out.credits,
          empty: !!out.empty,
          unrecognised: !!out.unrecognised,
          why: out.why || null,
          stop: out.stop || null,
          ...this.readWith(out.r ? out.r.data : undefined, body?.recipe, step),
          ...rawAnswer(out.r ? out.r.data : undefined),
          // SAY THAT IT WAS CUT SHORT (BEA-1554). The clamp is silent, and silence reads as "that was
          // everything": his worker asked for `pages: 'all'`, was handed ONE page, and reported
          // "fetched Reddit until it ran out and found 6 posts" — then asked whether to write 6
          // instead of 100. It had been lied to. A cap the caller cannot see is worse than no cap,
          // because the wrong conclusion looks like a fact.
          ...(trial
            ? { cappedForCheck: true, why: 'This is a check before going live, so only ONE page was fetched. Do NOT treat this as the source running out — there is very likely more.' }
            : {}),
        };
      });
      return { ...(hit.value as any), replayed: hit.replayed };
      return hit;
    }

    if (body?.sourceId) {
      const plan = planFromAgent(job);
      const src = plan.sources.find((s) => s.id === String(body.sourceId));
      if (!src) {
        // An error that says what to do instead (BEA-1498). A repair of his ESP32 agent rewrote a
        // working `kit.callAll` into `kit.fetchSource`, which can NEVER work for a goal-built job —
        // it has no plan and therefore no sources — and the old message did not say so, so the next
        // repair had no way to learn.
        const plan = planFromAgent(job);
        const has = plan.sources.length;
        throw new BadRequestException(
          has
            ? `This job has no source called "${body.sourceId}". Its sources are: ${plan.sources.map((x) => x.id).join(', ')}.`
            : `This job has no plan and no sources, so kit.fetchSource cannot be used here. Fetch by action id instead: kit.callAll('${String(body.sourceId)}', args, { pages }) — same paging, same de-duping, same credit checks.`,
        );
      }
      // Pages are the plan's unless the worker asks for fewer/more, and always inside the cap.
      if (src.kind === 'source' && body.pages !== undefined && body.pages !== null) src.pages = clampPages(body.pages);
      if (trial && src.kind === 'source') src.pages = 1; // a trial fetches one page (BEA-1552)
      const args = { sourceId: src.id, pages: src.kind === 'source' ? src.pages : 0 };
      // The whole paged fetch is ONE journal step, on purpose: the pages of a source are one
      // answer, and a per-page journal would have to invent sub-positions the worker cannot know.
      // The narrow cost, said out loud: if this ever throws MID-loop — not one of the controlled
      // `{stop}` answers, but a real exception after some pages were already billed — nothing is
      // journalled and a resume re-fetches from page 1. `runDetailed()` answers rather than throws
      // on every vendor road, which is what keeps that narrow; it is the reason it must stay so.
      const hit = await this.journal.once(runId, seq, 'fetchSource', args, async () => {
        // A trial remembers what it READ, so the screen can say "read 15, kept 5" (BEA-1416).
        const out = await this.sources.fetchBlock(src, this.guard(runId, job, seq), this.ctx(runId, job, seq), step, { hint: sourceHint(src, plan.sources), progress });
        const label = sourceLabel(src, plan.sources);
        return {
          ok: !out.stop,
          // Which source this was. The worker knows (it asked), but the JOURNAL does not record the
          // arguments of a call — and the self-heal loop (BEA-1393) reads the journal off a failed
          // run to keep the answer that broke it. Without this it would have to match on the label.
          sourceId: src.id,
          label,
          credits: out.credits,
          empty: !!out.empty,
          // The BEA-1377 tripwire's verdict rides to the worker, so `kit.expect` can tell "the vendor
          // had nothing" (a fine, quiet run) from "we could not read what it sent" (a failure).
          unrecognised: !!out.unrecognised,
          why: out.why || null,
          stop: out.stop || null,
          ...this.readWith(out.r ? out.r.data : undefined, body?.recipe, step),
          // The paged/creators road keeps the app's reading — paging really does need the know-how
          // cards, and a worker has no database to read them from. But it gets the real answer too
          // (BEA-1457), so a program that disagrees with how a row was read can just read it itself.
          ...rawAnswer(out.r ? out.r.data : undefined),
        };
      });
      if (trial && !hit.replayed) await this.trials?.holdFetched?.(runId, Number((hit.value as any)?.table?.rows?.length) || 0);
      return { ...(hit.value as any), replayed: hit.replayed };
    }

    const actionId = String(body?.actionId || '');
    if (!actionId.startsWith('svc:')) throw new BadRequestException('Give a sourceId from the job\'s plan, or an actionId that starts with "svc:".');
    // Any connected action, not just this job's own (BEA-1457). The per-job allow-list that used to
    // stand here (BEA-1401) was the thing that made a worker brittle and every new capability a hole
    // cut by hand: a program that discovers mid-run that it needs one more call could not make it.
    //
    // Nothing is given up by removing it, because none of the real guards ever lived here. They live
    // in `ServiceActionsService`, one layer down, and they still fire on every single call:
    //   - the can't-undo gate parks the run and asks the owner (a read is never gated);
    //   - the daily credit ceiling is checked BEFORE the call by `guard()`, fail-closed;
    //   - a `ToolCall` row is written whatever happens, so the ledger stays whole;
    //   - a trial writes nothing and sends nothing, whatever it calls.
    // What a runaway program can now do is spend a day's credits on the wrong reads. What it still
    // cannot do is anything irreversible without his yes.
    const args = body?.args && typeof body.args === 'object' ? body.args : {};

    // A TRIAL WRITES NOTHING — including through this road (BEA-1471).
    //
    // The promise on his screen is "Nothing was saved and nothing was sent", and until now it was
    // only true of `kit.writeDocument` and `kit.notify`. A program calling Notion or WhatsApp
    // through `kit.call` — which is what every program written since BEA-1457 actually does — really
    // wrote and really sent. The comment a few lines below this one claimed otherwise and was wrong.
    //
    // Reads still happen, so a trial shows him real rows from his real account. Only the writes are
    // held, and the answer says so plainly rather than pretending to be the vendor's.
    if (trial && !(await this.isRead(actionId))) {
      const held = { ok: true, credits: 0, error: null, notFound: false, stop: null, table: null, trial: true, held: true, why: `This is a trial, so ${actionId} was not really called. Nothing was written and nothing was sent.` };
      await this.stepper(runId)({ label: `Held back — ${actionId}`, status: 'info', kind: 'held', detail: 'a trial writes nothing and sends nothing', nodeId: nodeIdOf(seq) });
      return { ...held, replayed: false };
    }

    const hit = await this.journal.once(runId, seq, 'tool', { actionId, args }, async () => {
      const stop = await this.guard(runId, job, seq)(actionId);
      if (stop) return { ok: false, credits: 0, stop, table: null };
      const r = await this.actions.runDetailed(actionId, '', this.ctx(runId, job, seq)(actionId, args));
      return {
        ok: !!r.ok,
        // WHICH action this was (BEA-1495). The journal records a call's position and its answer, not
        // the arguments that went out — so a repair reading a failed run had to look the action up on
        // the job's PLAN. A goal-built job has no plan, `actionOf()` came back empty, and every piece
        // of evidence was dropped by `keepEvidence`'s `if (!f.actionId) continue`. The repair of his
        // ESP32 agent therefore ran with no evidence at all, and deleted an ask-the-owner path
        // instead of fixing the fetch. Carrying the id in the answer costs nothing and ends that.
        actionId,
        credits: Number(r.credits) || 0,
        error: r.error || null,
        notFound: !!r.notFound,
        // Arguments this action does not take, so they never went out (BEA-1474). Said out loud so a
        // program can fix its own spelling — a silently dropped `maxResults` is what made Gmail
        // refuse a whole day of mail with HTTP 413 while the run looked like it had asked for a cap.
        ...((r as any).droppedArgs?.length ? { droppedArgs: (r as any).droppedArgs } : {}),
        stop: r.ok ? null : r.error || 'the call failed',
        // The app's reading, kept so nothing already built breaks…
        table: r.ok ? tableOf(r.data) : null,
        // …and the answer the vendor really sent, which is the whole point of BEA-1457. Before this,
        // `tableOf()` ran and the original was thrown away, so a shape our reader did not know could
        // only ever be fixed in the app — recipes, learned shapes, tripwires, each one hours of work
        // and a chance to get it wrong. A program that can see the answer just reads it.
        ...rawAnswer(r.ok ? r.data : undefined),
      };
    });
    return { ...(hit.value as any), replayed: hit.replayed };
  }

  // ---- looking things up ------------------------------------------------------------------------

  /**
   * What exists and what it does (`kit.facts`) — the same catalog and the same fact cards the chat
   * builder reads, reachable from inside a run (BEA-1457).
   *
   * Free: no vendor call, no credits, no journal position. A lookup has no effect to replay, and
   * giving it a place in the call order would mean a program that looks something up on Tuesday and
   * not on Wednesday could never resume. So it is like `kit.checkpoint` — outside the order.
   *
   * This is what lets a worker find an action nobody thought of when it was compiled, which is the
   * other half of removing the allow-list: reach is no use without discovery.
   */
  @Post('facts')
  async facts(@Req() req: any, @Body() body: any) {
    who(req); // the token still has to be a real run's
    if (!this.lookup) return { ok: false, error: 'the tool catalog is not available on this run', services: [], actions: [], card: null };
    const actionId = String(body?.actionId || '').trim();
    if (actionId) {
      const card = await this.lookup.getAction(actionId).catch(() => null);
      return { ok: !!card, actionId, card: card?.text || null, error: card ? null : `nothing in the catalog is called ${actionId}` };
    }
    const service = String(body?.service || '').trim();
    if (service) {
      const actions = await this.lookup.findActions(service, String(body?.q || '')).catch(() => []);
      return { ok: true, service, actions: (actions || []).slice(0, FACTS_MAX).map((a: any) => ({ id: a.id, name: a.name || null, what: a.what || a.description || null })) };
    }
    const services = await this.lookup.services().catch(() => []);
    return { ok: true, services: (services || []).map((s: any) => ({ slug: s.slug, name: s.name, actions: s.actions })) };
  }

  /**
   * Deep research (`kit.research`) — ours, budgeted, on the flat-rate engine (BEA-1458).
   *
   * This was reachable from the old road and from nowhere else, so removing that road took it away
   * from every agent — a regression stated openly at the time and closed here. The hard caps live in
   * `DeepResearchService` (24 searches, 10 page reads) and nothing a worker sends can exceed them.
   */
  @Post('research')
  async research(@Req() req: any, @Body() body: any) {
    const { runId } = who(req);
    const seq = seqOf(body);
    if (!this.research_) throw new BadRequestException('Deep research is not available on this run.');
    const question = String(body?.question || '').trim();
    if (!question) throw new BadRequestException('Deep research needs a question.');
    const step = this.stepper(runId);
    const budget = body?.budget && typeof body.budget === 'object' ? body.budget : undefined;
    const hit = await this.journal.once(runId, seq, 'research', { question, budget: budget || null }, async () => {
      try {
        const out = await this.research_!.run(question, {
          budget,
          onLine: (t: string) => { void this.agent.stampProgress?.(runId, String(t).slice(0, 200)); },
        });
        await step({ label: `Researched: ${question.slice(0, 120)}`, status: 'done', detail: `${out.spend?.sources || 0} sources`, nodeId: nodeIdOf(seq) });
        return { ok: true, report: out.report, spend: out.spend || null, error: null };
      } catch (e: any) {
        // A failed research run still spent search credits — the spend rides on the error on purpose
        // (`DeepResearchError`), so it is reported rather than silently written off.
        return { ok: false, report: null, spend: e?.spend || null, error: String(e?.message || e).slice(0, 300) };
      }
    });
    return { ...(hit.value as any), replayed: hit.replayed };
  }

  /**
   * Several sources' tables → one (`kit.merge`), by `mergeTables()` — the same union, the same
   * `source` column, the same de-dupe on the union's id column the plan runner uses. Pure and free,
   * so it is not journalled: a replay recomputes it from what it was given.
   */
  @Post('merge')
  async merge(@Req() req: any, @Body() body: any) {
    const tables = Array.isArray(body?.tables) ? body.tables : [];
    if (!tables.length) throw new BadRequestException('Nothing to merge.');
    // A table's id becomes the `source` column the owner reads in his sheet, so it is the app that
    // names it, never the worker (BEA-1395). The acceptance run found the one real difference
    // between the two roads here, on his own job: it has TEN sources on ONE action (BEA-1374), so
    // the plan runner writes each source's LABEL ("instagram.search_profiles · smart home") while
    // the worker Codex wrote handed in the source ids, which `mergeTables` renders as
    // "instagram.search_profiles#2". A source id of this job's own plan is translated to that
    // source's label here — the same `sourceLabel()` — and anything else is left exactly as it came,
    // so a worker that already passes labels (the documented shape) is completely unaffected.
    const name = await this.sourceNames(req);
    const clean = tables.map((t: any, i: number) => ({ id: name(String(t?.id || `source ${i + 1}`)), table: asTable(t?.table) }));
    if (clean.length === 1) return { ...clean[0].table };
    return mergeTables(clean);
  }

  /** `sourceId → the label the plan runner would write`, for this run's job. Unknown ids pass through. */
  private async sourceNames(req: any): Promise<(id: string) => string> {
    const { agentId } = who(req);
    try {
      const plan = planFromAgent(await this.job(agentId));
      const labels = new Map(plan.sources.map((s) => [s.id, sourceLabel(s, plan.sources)]));
      return (id: string) => labels.get(id) || id;
    } catch {
      return (id: string) => id;
    }
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
        const shaped = await this.social.shape(prompt, table, header, (n, of) => this.agent.stampProgress?.(runId, `shaping batch ${n} of ${of}`));
        let aiTokens = 0;
        try { aiTokens = (await this.llm.tokensSince?.('social-shape', start)) || 0; } catch { aiTokens = 0; }
        // Onto the run, so a worker run shows its AI cost like a plan run does (BEA-1394 §I). Inside
        // `once()` on purpose: a replayed call spent nothing, so it must not be counted twice.
        await this.agent.addAiTokens?.(runId, aiTokens)?.catch?.(() => undefined);
        return { ok: !!shaped.ok, columns: shaped.columns || null, rows: shaped.rows || null, note: shaped.note || null, error: shaped.error || null, aiTokens };
      });
      return { ...(hit.value as any), replayed: hit.replayed };
    }

    const prompt = String(body?.prompt || '');
    if (!prompt.trim()) throw new BadRequestException('An AI step needs a prompt, or a table to shape.');
    const maxTokens = Math.min(Math.max(1, Number(body?.maxTokens) || 1000), AI_MAX_TOKENS);
    const hit = await this.journal.once(runId, seq, 'ai', { helper, prompt, maxTokens }, async () => {
      const start = new Date();
      const text = await this.llm.completeHelper(helper as any, prompt, maxTokens, helper).catch((e: any) => {
        throw new Error(`the ${helper} model could not be reached — ${String(e?.message || e).slice(0, 120)}`);
      });
      let aiTokens = 0;
      try { aiTokens = (await this.llm.tokensSince?.(helper, start)) || 0; } catch { aiTokens = 0; }
      await this.agent.addAiTokens?.(runId, aiTokens)?.catch?.(() => undefined); // this run's own total (BEA-1394)
      return { ok: !!text, text: text || null, aiTokens };
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
    const { runId, agentId, trial } = who(req);
    const seq = seqOf(body);
    const job = await this.job(agentId);
    const step = this.stepper(runId);
    const kind = String(body?.kind || 'document');
    const title = String(body?.title || job?.name || 'Agent result').slice(0, 200);

    // A TRIAL writes nothing (BEA-1408). It holds the rows for the screen and says so on the run, so
    // he can see exactly what would have been saved without a single row landing anywhere.
    if (trial) {
      const table = kind === 'sheet' ? asTable(body?.table) : { columns: [], rows: [] as any[][] };
      const markdown = kind === 'sheet' ? '' : String(body?.markdown || '');
      await this.trials?.hold?.(runId, { kind, title, table, markdown });
      await step({
        label: kind === 'sheet'
          ? `Trial — ${table.rows.length} row${table.rows.length === 1 ? '' : 's'} ready for your sheet. Nothing was written.`
          : 'Trial — the document is ready. Nothing was saved.',
        status: 'done',
        // A HELD WRITE IS A FACT, NOT A FORM OF WORDS (BEA-1570). The pre-flight check has to tell
        // "the trial stopped this" from "the worker broke", and it used to do that by matching the
        // prose of the OTHER held-write path ("Held back — …"). This road writes a friendlier
        // sentence, so his agent's held sheet read as a real failure and the build was refused.
        kind: 'held',
        nodeId: 'output',
      });
      return { ok: true, trial: true, url: null, id: null, created: false, skipped: 0, nothingNew: false, rows: table.rows.length, docId: null };
    }

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
    const { runId, agentId, trial } = who(req);
    const seq = seqOf(body);
    const job = await this.job(agentId);
    const step = this.stepper(runId);
    const headline = String(body?.headline || '').slice(0, 600);
    if (!headline.trim()) throw new BadRequestException('A message needs a headline.');
    const detail = body?.detail ? String(body.detail).slice(0, 1200) : '';
    // The agent's OWN message, in full (BEA-1407). A WhatsApp TEMPLATE variable may not hold a
    // newline, so a grouped summary cannot ride inside one — it goes as a second, free-text message
    // (`longBody`), which Meta delivers only while the owner's 24-hour window is open. The template
    // always arrives; the full text arrives when it can, and the step says which happened. Without
    // this the only thing a worker could ever send was "<job> finished · N rows" — the receipt the
    // owner rightly called useless.
    const message = body?.message ? String(body.message).slice(0, MESSAGE_CHARS) : '';
    const url = String(body?.url || `/agent/runs/${runId}`);
    const wantWhatsApp = !!body?.whatsapp;
    const wantTelegram = !!body?.telegram;
    if (!wantWhatsApp && !wantTelegram) throw new BadRequestException('Say where the message goes: whatsapp, telegram, or both.');
    const title = String(body?.title || job?.name || 'Your agent').slice(0, 120);

    // A TRIAL sends nothing, to anybody (BEA-1408). The message is kept exactly as it would arrive
    // and drawn on screen; sending it is his tap, to his own number, and nowhere else.
    if (trial) {
      await this.trials?.holdMessage?.(runId, message || `${headline}${detail ? `\n\n${detail}` : ''}`);
      await step({ label: 'Trial — your message is ready. It was NOT sent.', status: 'done', kind: 'held', nodeId: 'notify' });
      return { ok: true, trial: true, whatsapp: null, telegram: null };
    }

    const hit = await this.journal.once(runId, seq, 'notify', { headline, detail, url, message, whatsapp: wantWhatsApp, telegram: wantTelegram }, async () => {
      const out: any = { ok: false, whatsapp: null, telegram: null };
      if (wantTelegram) {
        // Telegram has no template and no window — the full message goes as it is written.
        const tgText = message || `${headline}${detail ? `\n\n${detail}` : ''}`;
        const tg = await this.budget?.pushAlert?.(job, tgText, runId).catch((e: any) => ({ sent: false, why: String(e?.message || e) }));
        out.telegram = { sent: !!tg?.sent, why: tg?.why || null };
        await step({ label: tg?.sent ? 'Sent on Telegram' : `⚠️ Not sent on Telegram — ${tg?.why || 'Telegram is not set up'}`, status: tg?.sent ? 'done' : 'info', nodeId: 'notify' });
      }
      if (wantWhatsApp) {
        const wa = await this.alerts?.runFinished?.(title, headline, url, { ...(detail ? { detail } : {}), ...(message ? { longBody: message } : {}) }).catch((e: any) => ({ sent: false, why: String(e?.message || e) }));
        out.whatsapp = { sent: !!wa?.sent, why: (wa as any)?.why || null };
        await step({ ...whatsappStepLabel(wa), nodeId: 'notify' });
        // Honest about the half that may not arrive: the template always does, the full text only
        // inside the 24-hour window. Never let a delivered receipt read as a delivered summary.
        if (message) {
          const followUp = (wa as any)?.followUp;
          await step({
            label: followUp === 'sent'
              ? 'Sent your full message on WhatsApp'
              : `⚠️ Only the short notice reached WhatsApp — your full message needs you to have messaged in the last 24 hours. It is on the run screen${wantTelegram ? ' and went out on Telegram' : ''}.`,
            status: followUp === 'sent' ? 'done' : 'info',
            nodeId: 'notify',
          });
          out.messageDelivered = followUp === 'sent';
        }
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
  /**
   * What this run has really done so far, in one line, from its own `ToolCall` rows.
   *
   * Only facts the app can prove: how many calls reached a vendor, how many succeeded, and what they
   * cost. Empty when there is nothing to say — a question is not improved by "0 calls, 0 credits".
   */
  private async runFacts(runId: string): Promise<string> {
    // `runCost` is already THE function that adds up a run's real calls and credits — the run screen
    // and the cost rollup both read it. Counting them again here would be a second answer to the same
    // question, which is the mistake this codebase keeps paying for.
    const cost = await this.agent.runCost?.(runId).catch(() => null);
    if (!cost || (!cost.calls && !cost.credits)) return '';
    // Each page of a paged fetch is one call, so calls ARE the pages he cares about. Said as pages
    // because that is the word the worker uses when it invents a number — his last two questions both
    // quoted a page limit ("100 pages", "the 15-page cap") that nothing had ever read. Now the true
    // figure stands next to the claim.
    const bits = [`${cost.calls} page${cost.calls === 1 ? '' : 's'} fetched`];
    if (cost.credits > 0) bits.push(`${cost.credits} credit${cost.credits === 1 ? '' : 's'}`);
    return `What actually happened: ${bits.join(' · ')}.`;
  }

  @Post('ask')
  async ask(@Req() req: any, @Body() body: any) {
    const { runId, agentId, trial } = who(req);
    const seq = seqOf(body);
    const question = String(body?.question || '').trim();
    if (!question) throw new BadRequestException('A question needs to say something.');
    const choices = Array.isArray(body?.choices) ? body.choices.map((c: any) => String(c)).slice(0, 6) : [];
    const ifNoAnswer = body?.ifNoAnswer === undefined || body?.ifNoAnswer === null ? null : String(body.ifNoAnswer);
    if (choices.length && ifNoAnswer === null) throw new BadRequestException('A question with choices must say what to do if nobody answers (ifNoAnswer).');
    // A TRIAL NEVER REACHES HIS PHONE (BEA-1554).
    //
    // Trial mode has always held writes and sends — but an ASK went out through a different door, so
    // the pre-promotion check I added in BEA-1553 messaged him on WhatsApp about a build he had not
    // asked for and could not act on. A check that interrupts him is not a check, it is a nuisance.
    //
    // It takes its own default and carries on, so the smoke run still learns whether the worker can
    // meet the vendor — which is the only thing it exists to find out. Needing to ask is not a
    // failure, and it is recorded on the run so it is visible without anyone being disturbed.
    if (trial) {
      /**
       * AN INSTANT ANSWER PLUS A RETRY IS A LOOP (BEA-1571).
       *
       * His YouTube check asked the same question **1,610 times in 150 seconds** — 764KB of step
       * log — and every one was answered here in microseconds. Both halves were individually right:
       * a trial holds the sheet write (so there is genuinely no link to give), and a trial never
       * reaches his phone (so it answers itself at once). Together they spin, because the worker
       * quite reasonably retries when the answer does not solve its problem.
       *
       * Nothing bounded it. So: the same question, three times, and the check stops — with a
       * sentence that names the real cause rather than blaming the worker for asking.
       */
      const asked = this.trialAsks.get(runId) || new Map<string, number>();
      const key = question.slice(0, 200);
      const seen = (asked.get(key) || 0) + 1;
      asked.set(key, seen);
      this.trialAsks.set(runId, asked);
      if (seen > TRIAL_ASK_LIMIT) {
        throw new BadRequestException(
          `This check stopped: the worker asked "${question.slice(0, 120)}" ${seen} times. A check holds every write, so there is no sheet link to give it — that question can only be answered on a real run.`,
        );
      }
      const taken = ifNoAnswer ?? (choices[0] ?? '');
      await this.stepper(runId)({
        label: `Not asked — this is a check, not a real run: "${question.slice(0, 120)}"`,
        status: 'info',
        detail: taken ? `Carried on with "${taken}", which is what it would do if nobody answered.` : 'Carried on without an answer.',
        kind: 'ask',
      }).catch(() => undefined);
      return { answered: true, answer: taken, trial: true, asked: false };
    }
    const deadlineHours = Math.min(Math.max(Number(body?.deadlineHours) || ASK_DEADLINE_HOURS, 1), 24 * 14);
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
      // The answer is in. Say on the run where it came from — a 12-hour silence that fell back to
      // the worker's own default must never read as if the owner had chosen it (§H).
      const viaTimeout = wp?.status === 'expired' || wp?.answeredVia === 'timeout';
      await this.agent
        .appendStep(runId, {
          label: viaTimeout
            ? `No answer in ${deadlineHours} hours — carrying on with "${String(answer).slice(0, 120)}", the default this question named`
            : `Carrying on with your answer: ${String(answer).slice(0, 160)}`,
          status: viaTimeout ? 'info' : 'done',
          kind: 'ask',
        })
        .catch(() => undefined);
      const answered = { waiting: false, answer, waitpointId: v.waitpointId };
      await this.journal.write(runId, seq, stepKey, 'ask', answered);
      return { ...answered, replayed: true };
    }

    const job = agentId ? await this.agent.getAgent(agentId).catch(() => null) : null;
    const wp: any = await this.park(runId, {
      question,
      choices,
      ifNoAnswer,
      deadlineHours,
      jobName: (job as any)?.name || 'Your agent',
    });
    await this.journal.write(runId, seq, stepKey, 'ask', { waiting: true, waitpointId: wp?.id || null });
    return { waiting: true, waitpointId: wp?.id || null, question };
  }

  /**
   * Park the run on a question and get it onto the owner's phone (§H). The one place both roads —
   * `kit.ask` and a can't-undo gate — go through, so a parked run always looks the same:
   *
   *  1. the `Waitpoint` is written and the run goes to **`awaiting_input`** (`AgentService.ask()`);
   *  2. the run is marked parked, so a restart leaves it alone instead of failing it as an orphan
   *     (`reconcileOrphans` only fails runs with no way to advance) and the Codex resume sweeper
   *     still skips it — it reads `runKind`, which is already `worker`;
   *  3. the question goes out on WhatsApp;
   *  4. this spawn's tokens are revoked and the worker EXITS. Nothing is held open, so a two-day
   *     wait costs nothing at all.
   */
  private async park(
    runId: string,
    o: { question: string; choices: string[]; ifNoAnswer: string | null; deadlineHours: number; jobName: string },
  ): Promise<any> {
    const wp: any = await this.agent.ask(runId, {
      question: o.question,
      kind: o.choices.length ? 'choice' : 'free_text',
      options: o.choices,
      defaultValue: o.ifNoAnswer ?? undefined,
      expiresInMs: o.deadlineHours * 3600_000,
      askedVia: 'whatsapp',
    } as any);
    await this.agent.parkRun?.(runId, 'worker')?.catch?.(() => undefined);
    await this.agent.appendStep(runId, { label: `Waiting for you: ${o.question.slice(0, 200)}`, status: 'running', kind: 'ask' }).catch(() => undefined);
    // THE NUMBERS COME FROM WHAT HAPPENED, NOT FROM WHAT IT REMEMBERS (BEA-1546).
    //
    // His Reddit worker told him it had gone "after 100 pages". It had done 11 — its own step log said
    // so two lines above. A question carrying a wrong number is worse than no number: he answered it
    // as if 100 pages had really been tried, and the option he was offered ("increase the paging
    // limit") could never have worked.
    //
    // So the app appends what it can prove from this run's own tool calls. The worker's wording is
    // left exactly as written — this stands beside it as the record.
    const facts = await this.runFacts(runId).catch(() => '');
    const asked = facts ? `${o.question}\n\n${facts}` : o.question;
    await this.owner?.send?.(runId, wp?.id || '', { jobName: o.jobName, question: asked, choices: o.choices }).catch(() => undefined);
    this.tokens.revokeRun(runId);
    return wp;
  }

  /**
   * A can't-undo call was reached (BEA-1348 × §H). A worker has no screen to show a confirm card on,
   * so the run parks on the gate's own question and the owner answers it on WhatsApp hours later.
   *
   * Nothing is journalled — the call never happened, so the resumed worker makes it again at the
   * same place in the call order, and by then the decision is on record: a yes carries the exact
   * arguments he was shown, a no stops the step with his words. The one thing it must never do is
   * park in a circle, so a decision that is already settled is acted on rather than re-asked.
   */
  private async parkOnGate(req: any, body: any, gate: any): Promise<any> {
    const { runId, agentId } = who(req);
    const seq = seqOf(body);
    const nodeId = nodeIdOf(seq);
    const settled = await this.gates?.decisionFor?.(gate.actionId, { runId, nodeId }).catch(() => null);
    if (settled === 'rejected') {
      return { ok: false, credits: 0, table: null, stop: `You said no to this: ${gate.headline}. Nothing was sent.` };
    }
    if (settled === 'approved') {
      // He said yes, the step ran again, and it STILL asked. Re-parking would ask the same question
      // for ever, so it stops here and says exactly that.
      throw new BadRequestException(`You approved "${gate.headline}", but the step asked again instead of using your approval — nothing was sent. Run the job again, or release this gate for good in /tools.`);
    }
    const job = agentId ? await this.agent.getAgent(agentId).catch(() => null) : null;
    if (settled !== 'pending') await this.gates?.recordPending?.(gate, { runId, nodeId }).catch(() => undefined);
    const wp = await this.park(runId, {
      question: gate.question,
      choices: this.gates?.options || ['Yes, run it', 'No, stop'],
      ifNoAnswer: 'No, stop', // silence may never approve something that cannot be taken back
      deadlineHours: ASK_DEADLINE_HOURS,
      jobName: (job as any)?.name || 'Your agent',
    }).catch(() => null);
    return { paused: true, waitpointId: (wp as any)?.id || null, question: gate.question };
  }

  // ---- the end ---------------------------------------------------------------------------------

  /**
   * The run is over (`kit.finish` / `kit.fail`). The spawn's tokens stop working the same moment,
   * and the run's journal is dropped inside `finishRun()`: it existed to make a resume free, and a
   * finished run is never resumed — leaving it would keep every fetched table in the database for
   * ever. It lives there rather than here because this is only one of the four roads that end a
   * worker run (BEA-1401).
   */
  @Post('finish')
  async finish(@Req() req: any, @Body() body: any) {
    const { runId, agentId } = who(req);
    this.trialAsks.delete(runId); // the check's repeat-question tally dies with the run (BEA-1571)
    const status = body?.status === 'failed' ? 'failed' : body?.status === 'cancelled' ? 'cancelled' : 'done';
    const error = body?.error ? String(body.error).slice(0, 2000) : undefined;
    // The step is what the customer reads (BEA-1580): a plumbing-class failure becomes the calm
    // shape, a customer-actionable one ends in its move. `finishRun` below still stores the honest
    // internal sentence untouched on the run row — that one is ours (and BEA-1581's).
    if (status === 'failed' && error) {
      await this.agent.appendStep(runId, { label: customerWords(error), status: 'failed' }).catch(() => undefined);
      // A worker failing on OUR plumbing — NOT_REPEATABLE, a crash, the app restarting under it —
      // phones home (BEA-1581). The classifier decides; his own failures never page us.
      opsAlertIfPlumbing(error, { agentId, runId });
    }
    const run = await this.agent.finishRun(runId, {
      status: status as any,
      error,
      resultText: body?.resultText ? String(body.resultText) : undefined,
      outputUrl: body?.outputUrl ? String(body.outputUrl) : undefined,
      outputDocId: body?.outputDocId ? String(body.outputDocId) : undefined,
    });
    this.tokens.revokeRun(runId);
    // The journal is dropped by `finishRun()` itself now (BEA-1401), so every road that ends a worker
    // run forgets it — this one, the stall watchdog, a deadline with no default, an overtaken run.
    return { ok: true, status: (run as any)?.status || status };
  }

  // ---- shared plumbing --------------------------------------------------------------------------

  /**
   * A can't-undo gate is thrown, never returned (`GatePause`). Out of a controller it would leave
   * the process as a bare 500 — "Internal server error" — and the worker would say nothing useful.
   * So it comes back as the gate's own plain sentence, and NOTHING is journalled: the call never
   * happened, so a later approval may still make it. (A worker parking on a gate is piece 7.)
   */
  private async saying<T>(work: () => Promise<T>, park?: { req: any; body: any }): Promise<T> {
    try {
      return await work();
    } catch (e: any) {
      const gate = e instanceof GatePause || e?.name === 'GatePause';
      // The tool route parks and asks (§H). Everywhere else — the sheet, the document — a gate is
      // still the plain refusal it was: those calls go to fixed, known-safe actions, and a road
      // that cannot carry the owner's approval back into the call must not pretend it can.
      if (gate && park) return (await this.parkOnGate(park.req, park.body, (e as any).gate)) as any;
      if (gate) throw new BadRequestException(String(e?.message || 'Held for your approval.'));
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
  /**
   * Turn the vendor's answer into rows — with THIS tool's own recipe when the worker sent one, and
   * with the app's general reader otherwise (BEA-1415).
   *
   * The raw answer never leaves the app. The worker sends a recipe IN; the app applies it to data it
   * already holds. A recipe that names a path the answer does not have, or that would drop rows, is
   * refused with a plain reason and the general reader takes over — and the refusal is said out loud
   * on the run, because a silently ignored recipe is a lie about how the rows were read.
   */
  private readWith(data: any, raw: any, step: (s: any) => Promise<any> | any): { table: any; readBy: string; readNote: string } {
    if (data === undefined) return { table: null, readBy: 'app', readNote: '' };
    const recipe = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ReadRecipe) : null;
    const out = readAnswer(data, recipe);
    const note = readNote(out);
    // Only worth a step when something actually happened: a recipe was used, or one was refused.
    if (note) void step({ label: note, status: out.by === 'recipe' ? 'done' : 'info', nodeId: 'read' });
    return { table: out.table, readBy: out.by, readNote: note };
  }

  private guard(runId: string, job: any, seq?: number) {
    return async (actionId: string): Promise<string | null> => {
      // UNGUARDED (BEA-1471). The owner's decision, made twice and stated plainly: "Truly everything
      // goes — zero forced rules." So the daily credit ceiling no longer stops a worker's call, and
      // the can't-be-undone gate no longer pauses it.
      //
      // What that costs, written down here rather than discovered later: a looping program can spend
      // a day's credits, and an irreversible action runs without asking him first. He knows; he was
      // shown both consequences before choosing, and chose anyway. Do not put these back without
      // asking him — he has already answered.
      //
      // What is NOT given up: every call is still written to his ledger, so what happened is always
      // knowable afterwards, and a TRIAL still writes and sends nothing at all.
      if (UNGUARDED) return null;
      // A gate the owner already refused is settled: the call is not made, and the step says so in
      // his own decision rather than asking him the same thing again (BEA-1392 §H).
      if (seq !== undefined) {
        const settled = await this.gates?.decisionFor?.(actionId, { runId, nodeId: nodeIdOf(seq) }).catch(() => null);
        if (settled === 'rejected') return `You said no to this one, so it was not run.`;
      }
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

  /**
   * Every worker call is recorded like everyone else's: the run, the job, `runKind:'worker'`,
   * pinned args. `nodeId` is the call's own place in the call order, which is what makes an
   * approval spendable exactly once — the same yes can never let tomorrow's run through, and a
   * replayed worker asks for the approval at the very position that parked (BEA-1392).
   */
  /**
   * Is this action a read? (BEA-1471)
   *
   * The catalog's own answer, never a guess here: the provider's `readOnly`, the vendor's declared
   * method, then the verb. Fail-CLOSED — an action we cannot look up is treated as a write, because
   * being wrong in that direction holds back a read in a trial, and being wrong the other way sends
   * a real WhatsApp message during a run that promised it would not.
   */
  private async isRead(actionId: string): Promise<boolean> {
    const id = String(actionId || '');
    const service = id.startsWith('svc:') ? id.slice(4).split('.')[0] : '';
    // The catalog's own answer where it has one — the vendor's declared method is the most reliable
    // signal there is — falling back to the verb, which is the same rule the sampler uses.
    try {
      const t: any = await this.catalog?.byId?.(id);
      if (t) {
        if (t.readOnly === true) return true;
        if (String(t.method || '').toUpperCase() === 'GET') return true;
        if (t.risky === true) return false; // a can't-be-undone action is never a read
      }
    } catch { /* the verb below is the fallback, and it fails closed */ }
    return isReadAction(id, service);
  }

  private ctx(runId: string, job: any, seq?: number) {
    return (id: string, args: Record<string, any>) => ({ runId, runKind: 'worker', agentId: job?.id, args, argsPinned: true, label: id, ...(seq === undefined ? {} : { nodeId: nodeIdOf(seq) }) });
  }
}

/**
 * The vendor's answer, as it really arrived, ready to ride back to the worker (BEA-1457).
 *
 * Capped at `RAW_MAX` — the same 2 MB figure BEA-1395 measured a real Instagram profile answer
 * against, and the same one the sample store uses, so "too big to keep" means one thing in this
 * codebase and not two. Over the cap the raw answer is left out and `dataTruncated` says so; the
 * app's own `table` is still there, so an oversized answer degrades to exactly the old behaviour
 * instead of failing.
 *
 * The journal records this value, and the journal is dropped when the run finishes.
 */
export function rawAnswer(data: any): { data?: any; dataTruncated?: boolean; dataBytes?: number } {
  if (data === undefined) return {};
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(data ?? null), 'utf8');
  } catch {
    // Circular or otherwise unserialisable: it cannot cross the wire, so say so rather than throw.
    return { dataTruncated: true };
  }
  if (bytes > RAW_MAX) return { dataTruncated: true, dataBytes: bytes };
  return { data, dataBytes: bytes };
}

/** A worker call's step id — its place in the run's call order, stable across every replay. */
function nodeIdOf(seq: number): string {
  return `worker:${seq}`;
}

/** The identity the guard put on the request. Never read from the body — that is the whole rule. */
function who(req: any): { runId: string; agentId: string | null; trial: boolean } {
  const w = req?.worker;
  if (!w?.runId) throw new BadRequestException('No worker run on this request.');
  // `trial` comes off the TOKEN, never the body (BEA-1408) — a worker cannot argue its way out of it.
  return { runId: w.runId, agentId: w.agentId || null, trial: !!w.trial };
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
