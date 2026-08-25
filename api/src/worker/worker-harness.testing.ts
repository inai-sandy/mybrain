import { ToolSampleService } from '../tools/tool-sample.service';
import { argsHashOf } from '../tools/tool-sample';
import { SocialAgentRunService } from '../social/social-agent-run.service';
import { SourceFetchService } from '../social/source-fetch.service';
import { plainArgs } from '../social/plan';
import { RunJournalService } from './run-journal.service';
import { WorkerController } from './worker.controller';
import { WorkerTokenService } from './worker-token.service';
import { OwnerAskService } from './owner-ask.service';
import { GatePause } from '../tools/service-gates.service';

/** The owner's WhatsApp number in the tests — never used to send anything, only to be recognised. */
export const OWNER_NUMBER = '919999000111';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { makeKit } = require('./kit/kit.js');

/**
 * The in-process worker harness (BEA-1387).
 *
 * There is no worker runner yet (that is a later piece), so the kit is exercised the honest way:
 * the REAL controller, the REAL journal (gzip and all), the REAL fetcher and shaping step, and the
 * vendor's answers replayed out of REAL `ToolSample` rows. The only fakes are the things that leave
 * the building — the provider, the model, Documents, WhatsApp — and the plan runner is given exactly
 * the same ones, which is what makes the parity suite mean something.
 */

/**
 * A saved answer: one action + one exact set of arguments → one whole payload.
 *
 * `notFound` is the other real answer a vendor gives: the call went through and there was nothing
 * there (Scrape Creators answers `404 not_found` for a search with no posts). It carries no payload,
 * so there is nothing to save — the fake provider answers it the way the real one does.
 */
export type SampleFixture = { actionId: string; args: Record<string, any>; data?: any; notFound?: boolean };

export function fakePrisma() {
  const journal = new Map<string, any>();
  const samples: any[] = [];
  // Trials (BEA-1408): the rows and the message a trial run held back instead of writing and sending.
  const trials: any[] = [];
  return {
    rows: { journal, samples, trials },
    agentTrial: {
      create: async ({ data }: any) => { const row = { id: `t${trials.length + 1}`, createdAt: new Date(), updatedAt: new Date(), rows: '[]', columns: '[]', rowCount: 0, message: '', credits: 0, aiTokens: 0, verdict: '', error: '', ...data }; trials.push(row); return row; },
      update: async ({ where, data }: any) => { const row = trials.find((t) => t.id === where.id); Object.assign(row, data); return row; },
      findUnique: async ({ where }: any) => trials.find((t) => t.id === where.id) || null,
      findFirst: async ({ where }: any) => trials.filter((t) => (!where.runId || t.runId === where.runId) && (!where.areaId || t.areaId === where.areaId) && (where.briefVersion === undefined || t.briefVersion === where.briefVersion)).slice(-1)[0] || null,
      deleteMany: async ({ where }: any) => { const before = trials.length; for (let i = trials.length - 1; i >= 0; i--) if (trials[i].areaId === where.areaId) trials.splice(i, 1); return { count: before - trials.length }; },
    },
    runJournal: {
      findUnique: async ({ where }: any) => journal.get(`${where.runId_seq.runId}:${where.runId_seq.seq}`) || null,
      upsert: async ({ where, create, update }: any) => {
        const k = `${where.runId_seq.runId}:${where.runId_seq.seq}`;
        const now = journal.get(k);
        const row = now ? { ...now, ...update } : { id: `j${journal.size + 1}`, ...create };
        journal.set(k, row);
        return { id: row.id };
      },
      findMany: async ({ where }: any) => [...journal.values()].filter((r) => r.runId === where.runId).sort((a, b) => a.seq - b.seq),
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [k, r] of journal.entries()) if (r.runId === where.runId) { journal.delete(k); count++; }
        return { count };
      },
    },
    toolSample: {
      create: async ({ data }: any) => { const row = { id: `s${samples.length + 1}`, createdAt: new Date(), ...data }; samples.push(row); return { id: row.id }; },
      findMany: async ({ where }: any) => samples
        .filter((s) => s.actionId === where.actionId && (!where.kind || s.kind === where.kind) && (!where.argsHash || s.argsHash === where.argsHash))
        .sort((a, b) => b.createdAt - a.createdAt),
      deleteMany: async () => ({ count: 0 }),
      aggregate: async () => ({ _sum: { bytes: 0 } }),
      groupBy: async () => [],
    },
  } as any;
}

/** An `AgentService` stand-in: the run's steps, its end, its job row, its questions. */
export function fakeAgent(job: any) {
  const steps: any[] = [];
  const finished: any[] = [];
  const waitpoints: any[] = [];
  const runKinds: string[] = [];
  const progress: string[] = [];
  const outputs: string[] = [];
  /** Runs parked on a question, in order — `parkRun(runId, 'worker')` (BEA-1392). */
  const parked: { runId: string; sessionId: string | null }[] = [];
  /** What the real `resolve()` runs after an answer is applied — registered by `OwnerAskService`. */
  const hooks: {
    answered: ((runId: string, answer: string, via: string) => any) | null;
    /** What the real `finishRun()` runs on the way out of a worker run (BEA-1401): drop its journal. */
    journal: ((runId: string) => any) | null;
  } = { answered: null, journal: null };
  return {
    steps, finished, waitpoints, runKinds, progress, outputs, parked, job,
    parkRun: async (runId: string, sessionId?: string | null) => { parked.push({ runId, sessionId: sessionId ?? null }); },
    /** The real hook `resolve()` fires on EVERY answered question (BEA-1392). */
    setAnswerHook: (h: any) => { hooks.answered = h; },
    /** Exactly what the real one answers: the pending questions WhatsApp itself asked. */
    openWhatsAppAsks: async () => waitpoints.filter((w) => w.status === 'pending' && w.askedVia === 'whatsapp'),
    /** The real `answerById` shape — `applied:false` when it was already resolved, hook and all. */
    answerById: async (id: string, answer: unknown, via = 'web') => {
      const wp = waitpoints.find((w) => w.id === id);
      if (!wp) return { applied: false, alreadyResolved: true };
      if (wp.status !== 'pending') return { applied: false, alreadyResolved: true, status: wp.status };
      wp.status = 'answered';
      wp.answer = answer;
      wp.answeredVia = via;
      await hooks.answered?.(wp.runId, typeof answer === 'string' ? answer : JSON.stringify(answer ?? ''), via);
      return { applied: true, alreadyResolved: false, status: 'answered' };
    },
    /**
     * What `AgentService.sweepExpired()` does at the deadline to a question that named a default:
     * it is `resolve(wp, wp.defaultValue, 'timeout')` — the same road, the same hook.
     */
    timeout: async (id: string) => {
      const wp = waitpoints.find((w) => w.id === id);
      if (!wp || wp.status !== 'pending') return false;
      if (wp.defaultValue == null) { wp.status = 'expired'; return true; }
      wp.status = 'answered';
      wp.answer = wp.defaultValue;
      wp.answeredVia = 'timeout';
      await hooks.answered?.(wp.runId, String(wp.defaultValue), 'timeout');
      return true;
    },
    appendStep: async (_runId: string, s: any) => { steps.push(s); },
    stampProgress: async (_runId: string, label: string) => { progress.push(label); },
    setRunKind: async (_runId: string, kind: string) => { runKinds.push(kind); },
    /** Registered by `WorkerDispatchService` in the app; by `makeWorld` here (BEA-1401). */
    setJournalCleanup: (h: any) => { hooks.journal = h; },
    finishRun: async (runId: string, p: any) => { finished.push(p); await hooks.journal?.(runId); return { status: p?.status || 'done' }; },
    attachOutput: async (_runId: string, docId: string) => { outputs.push(docId); },
    getAgent: async (id: string) => (id === job.id ? job : null),
    updateAgent: async (_id: string, patch: any) => { Object.assign(job, patch); return job; },
    ask: async (runId: string, q: any) => {
      const wp: any = {
        id: `wp${waitpoints.length + 1}`,
        runId,
        question: q.question,
        kind: q.kind || 'choice',
        options: Array.isArray(q.options) ? q.options : [],
        status: 'pending',
        answer: null,
        answeredVia: null,
        askedVia: q.askedVia ?? null,
        defaultValue: q.defaultValue ?? null,
        createdAt: new Date(Date.now() + waitpoints.length), // asked in order, so "oldest" is real
      };
      waitpoints.push(wp);
      return wp;
    },
    getWaitpointById: async (id: string) => waitpoints.find((w) => w.id === id) || null,
    /** The owner answers, hours later. */
    answer: (id: string, answer: string) => {
      const wp = waitpoints.find((w) => w.id === id);
      if (wp) { wp.status = 'answered'; wp.answer = answer; }
    },
  };
}

/**
 * The world both roads run in. `samples` are written through the real `ToolSampleService`, and the
 * fake provider answers ONLY by replaying them — so a call with arguments nothing was saved for
 * fails, exactly as an unexpected call should.
 */
export async function makeWorld(opts: {
  job: any;
  samples: SampleFixture[];
  /** The shaping model: a pure function of the items it is shown, so both roads must agree. */
  shapeReply?: (prompt: string, items: any[]) => string;
  cards?: Record<string, any>;
}) {
  const prisma = fakePrisma();
  const store = new ToolSampleService(prisma);
  const notFound = new Set<string>();
  for (const s of opts.samples) {
    if (s.notFound) { notFound.add(`${s.actionId}:${argsHashOf(plainArgs(s.args))}`); continue; }
    await store.maybeKeep({ actionId: s.actionId, args: s.args, data: s.data, ok: true, readOnly: true, method: 'GET', providerKind: 'social' });
  }

  const calls: { id: string; args: any; ctx: any }[] = [];
  const sheets = { created: [] as string[], writes: [] as any[] };
  const actions = {
    /** Action ids that stop and ask before they run — a real `GatePause`, as the runner throws it. */
    gated: new Set<string>(),
    /** Action ids that simply succeed — a write has no saved answer to replay, it just happens. */
    succeed: new Set<string>(),
    runDetailed: async (id: string, _input: string, ctx: any) => {
      calls.push({ id, args: ctx?.args, ctx });
      // Mirrors the real rule (BEA-1471): a `runKind:'worker'` call is never gated, on the owner's
      // instruction. This fake stands in for `ServiceActionsService`, so it has to keep that rule or
      // a test passes here and the live system behaves differently.
      if (actions.gated.has(id) && String(ctx?.runKind || '') !== 'worker') {
        throw new GatePause({
          actionId: id,
          service: 'github',
          serviceName: 'GitHub',
          actionName: 'Delete a repository',
          args: ctx?.args || {},
          headline: 'Delete a repository on GitHub — inai-sandy/old-notes',
          question: 'Delete a repository on GitHub — inai-sandy/old-notes? This cannot be undone.',
        });
      }
      if (actions.succeed.has(id)) return { ok: true, credits: 0, data: { done: true } };
      if (id === 'svc:googlesheets.create_google_sheet1') { sheets.created.push(ctx.args.title); return { ok: true, data: { spreadsheetId: 'SHEET_1' } }; }
      if (id === 'svc:googlesheets.batch_update') { sheets.writes.push(ctx.args); return { ok: true, data: { totalUpdatedRows: ctx.args.values.length } }; }
      if (id === 'svc:googlesheets.batch_get') return { ok: true, data: { valueRanges: [{ values: [] }, { values: [] }] } };
      const hash = argsHashOf(plainArgs(ctx?.args || {}));
      // The vendor's "there is nothing here" — a real answer, not a broken call.
      if (notFound.has(`${id}:${hash}`)) return { ok: false, notFound: true, error: 'not_found', credits: 0, serviceName: 'Instagram', actionName: nameOf(id) };
      const data = await store.replay(id, hash);
      if (data === null) return { ok: false, error: `no saved answer for ${id} with ${JSON.stringify(ctx?.args)}`, credits: 0 };
      return { ok: true, credits: 1, serviceName: 'Instagram', actionName: nameOf(id), data };
    },
  };

  const shaped: string[] = [];
  const llm = {
    completeHelper: async (helper: string, prompt: string) => {
      shaped.push(helper);
      const items = itemsInPrompt(prompt);
      return (opts.shapeReply || defaultShapeReply)(prompt, items);
    },
    tokensSince: async () => 120,
  };
  const documents = { created: [] as any[], create: async (d: any) => { (documents.created as any[]).push(d); return { id: `doc${documents.created.length}` }; } };
  const alerts = {
    sent: [] as any[],
    /** Every question that went to the owner's phone (BEA-1392) — never a real send in a test. */
    asked: [] as any[],
    failures: [] as any[],
    /**
     * `opts.longBody` is the agent's OWN message in full (BEA-1407). The harness records it, and
     * `followUpDelivers` decides whether Meta's 24-hour window let it through — the difference
     * between the owner reading his summary and reading a receipt.
     */
    followUpDelivers: true,
    runFinished: async (title: string, headline: string, _path?: string, opts: any = {}) => {
      alerts.sent.push({ title, headline, detail: opts?.detail, longBody: opts?.longBody });
      return { sent: true, label: 'WhatsApp sent (template)', ...(opts?.longBody ? { followUp: alerts.followUpDelivers ? 'sent' : 'failed' } : {}) };
    },
    runFailed: async (name: string, reason: string) => { alerts.failures.push({ name, reason }); return { sent: false }; },
    ownerNumber: async () => OWNER_NUMBER,
    askOwner: async (m: any) => { alerts.asked.push(m); return { sent: true, via: 'template' as const }; },
  };
  /** The gates, as far as a worker can see them: what was held, and what the owner decided. */
  const gates = {
    options: ['Yes, run it', 'No, stop'],
    pending: [] as any[],
    settled: [] as any[],
    decisions: {} as Record<string, string>,
    recordPending: async (gate: any, ctx: any) => { gates.pending.push({ gate, ctx }); gates.decisions[`${ctx.runId}:${ctx.nodeId}`] = 'pending'; return 'g1'; },
    settlePending: async (runId: string, answer: string) => {
      const decision = /^(y|yes|ok|okay|go|run|do it|approve|allow|confirm|sure|proceed)\b/i.test(String(answer)) ? 'approved' : 'rejected';
      for (const k of Object.keys(gates.decisions)) if (k.startsWith(`${runId}:`) && gates.decisions[k] === 'pending') gates.decisions[k] = decision;
      gates.settled.push({ runId, answer, decision });
      return { settled: 1, decision };
    },
    decisionFor: async (_actionId: string, ctx: any) => (ctx?.runId && ctx?.nodeId ? gates.decisions[`${ctx.runId}:${ctx.nodeId}`] || null : null),
  };
  // `pushes` records what really went to Telegram — Telegram has no template and no 24-hour window,
  // so the whole message goes there as written (BEA-1407).
  const pushes: string[] = [];
  const budget = { checks: [] as string[], pushes, check: async (id: string) => { budget.checks.push(id); return { ok: true, spent: 0, ceiling: null, estimate: 1 }; }, pauseAgent: async () => undefined, pushAlert: async (_job: any, text: string) => { pushes.push(String(text || '')); return { sent: true }; } };
  const knowledge = { card: async (id: string) => opts.cards?.[id] ?? null };

  const sources = new SourceFetchService(actions as any, knowledge as any);
  const agent = fakeAgent(opts.job);
  const social = new SocialAgentRunService(agent as any, actions as any, llm as any, documents as any, alerts as any, undefined, budget as any, undefined, knowledge as any, sources);
  const journal = new RunJournalService(prisma);
  // The same registration the app makes at boot (BEA-1401): a worker run's journal is dropped by
  // `finishRun()`, so every road that ends a run forgets it and not just the worker's own `/finish`.
  agent.setJournalCleanup((runId: string) => journal.forget(runId));
  const tokens = new WorkerTokenService(journal, agent as any);
  // The REAL question road (BEA-1392): the same service the app registers on the callback
  // controller, with only the WhatsApp send itself faked.
  const owner = new OwnerAskService(agent as any, alerts as any, gates as any);
  // What exists, for `kit.facts` (BEA-1457). A fake shelf: three services, and one real fact card.
  const lookup = {
    services: async () => [
      { slug: 'instagram', name: 'Instagram', actions: 41 },
      { slug: 'gmail', name: 'Gmail', actions: 27 },
      { slug: 'googlesheets', name: 'Google Sheets', actions: 36 },
    ],
    findActions: async (service: string, words: string) => [
      { id: `svc:${service}.fetch_emails`, name: 'Fetch emails', what: `matched "${words}"` },
      { id: `svc:${service}.send_email`, name: 'Send an email', what: null },
    ],
    getAction: async (id: string) => (String(id).startsWith('svc:') ? { id, text: `# ${id}\nWhat it does: the fact card.` } : null),
  };
  // `kit.research` (BEA-1458). Answers a report, or throws with the spend riding on the error.
  const research = {
    calls: [] as string[],
    fail: null as string | null,
    run: async (question: string, _o: any) => {
      research.calls.push(question);
      if (research.fail) {
        const e: any = new Error(research.fail);
        e.spend = { searches: 3, extracts: 1, sources: 0 };
        throw e;
      }
      return { report: `# ${question}\n\nThe report.`, spend: { searches: 4, extracts: 2, sources: 6 } };
    },
  };

  // Read or write, for the trial guard (BEA-1471). The harness knows this honestly rather than by
  // guessing at names: an action with a SAVED ANSWER is a read, because saved answers are only ever
  // kept for successful reads. An action the fake provider is told to succeed at is a write.
  const catalog = {
    byId: async (id: string) => {
      if (opts.samples.some((f) => f.actionId === id)) return { id, readOnly: true, method: 'GET' };
      if (actions.succeed.has(id) || actions.gated.has(id)) return { id, method: 'POST', risky: actions.gated.has(id) };
      return null;
    },
  };

  const controller = new WorkerController(journal, tokens, agent as any, actions as any, sources, social, llm as any, budget as any, alerts as any, owner, gates as any, undefined, lookup as any, research as any, catalog as any);

  return { prisma, store, calls, sheets, shaped, documents, actions, alerts, budget, gates, agent, social, sources, journal, tokens, controller, owner, llm, lookup, research, catalog };
}

/**
 * A kit wired straight to the controller — what the worker runner will do over HTTP, minus the
 * process. The token is minted per spawn, exactly as it will be, and identity comes off it.
 */
export async function spawnKit(world: any, runId: string, agentId: string, opts: { trial?: boolean } = {}) {
  const spawn = await world.tokens.mint(runId, agentId, opts.trial ? { trial: true } : {});
  const req = { worker: { runId: spawn.runId, agentId: spawn.agentId, expiresAt: spawn.expiresAt, ...(opts.trial ? { trial: true } : {}) } };
  const routes: Record<string, string> = { tool: 'tool', facts: 'facts', research: 'research', merge: 'merge', ai: 'ai', step: 'step', output: 'output', notify: 'notify', ask: 'ask', finish: 'finish' };
  const fetchImpl = async (route: string, body: any) => {
    if (!world.tokens.verify(spawn.token)) throw new Error('This route is for a worker run, and needs its own run token.');
    const fn = routes[route];
    if (!fn) throw new Error(`no worker route "${route}"`);
    try {
      // Whatever the body says about who it is, the controller reads the token's identity only.
      // (A handler that needs no identity — the pure merge — takes the body alone.)
      const h = (world.controller as any)[fn];
      return await (h.length === 1 ? h.call(world.controller, body) : h.call(world.controller, req, body));
    } catch (e: any) {
      throw new Error(String(e?.response?.message || e?.message || e));
    }
  };
  return { kit: makeKit({ runId, seed: spawn.seed, fetchImpl }), spawn };
}

/** The items a shaping prompt was shown — the harness model reads its input like a real one would. */
export function itemsInPrompt(prompt: string): any[] {
  const at = prompt.indexOf('The items (JSON):');
  if (at === -1) return [];
  const json = prompt.slice(at + 'The items (JSON):'.length).split('\n\nReply with')[0].trim();
  try { return JSON.parse(json); } catch { return []; }
}

/** A deterministic "model": the same items always give the same rows, on either road. */
export function defaultShapeReply(_prompt: string, items: any[]): string {
  const rows = items.map((it) => [String(it.id ?? ''), String(it.caption ?? ''), String(it.url ?? '')]);
  return JSON.stringify({ columns: ['id', 'caption', 'link'], rows });
}

function nameOf(id: string): string {
  const action = id.split('.')[1] || id;
  return action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
