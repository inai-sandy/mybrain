import { ToolSampleService } from '../tools/tool-sample.service';
import { argsHashOf } from '../tools/tool-sample';
import { SocialAgentRunService } from '../social/social-agent-run.service';
import { SourceFetchService } from '../social/source-fetch.service';
import { plainArgs } from '../social/plan';
import { RunJournalService } from './run-journal.service';
import { WorkerController } from './worker.controller';
import { WorkerTokenService } from './worker-token.service';

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

/** A saved answer: one action + one exact set of arguments → one whole payload. */
export type SampleFixture = { actionId: string; args: Record<string, any>; data: any };

export function fakePrisma() {
  const journal = new Map<string, any>();
  const samples: any[] = [];
  return {
    rows: { journal, samples },
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
  return {
    steps, finished, waitpoints, runKinds, progress, outputs, job,
    appendStep: async (_runId: string, s: any) => { steps.push(s); },
    stampProgress: async (_runId: string, label: string) => { progress.push(label); },
    setRunKind: async (_runId: string, kind: string) => { runKinds.push(kind); },
    finishRun: async (_runId: string, p: any) => { finished.push(p); return { status: p?.status || 'done' }; },
    attachOutput: async (_runId: string, docId: string) => { outputs.push(docId); },
    getAgent: async (id: string) => (id === job.id ? job : null),
    updateAgent: async (_id: string, patch: any) => { Object.assign(job, patch); return job; },
    ask: async (_runId: string, q: any) => {
      const wp = { id: `wp${waitpoints.length + 1}`, question: q.question, status: 'pending', answer: null, defaultValue: q.defaultValue ?? null };
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
  for (const s of opts.samples) {
    await store.maybeKeep({ actionId: s.actionId, args: s.args, data: s.data, ok: true, readOnly: true, method: 'GET', providerKind: 'social' });
  }

  const calls: { id: string; args: any; ctx: any }[] = [];
  const sheets = { created: [] as string[], writes: [] as any[] };
  const actions = {
    runDetailed: async (id: string, _input: string, ctx: any) => {
      calls.push({ id, args: ctx?.args, ctx });
      if (id === 'svc:googlesheets.create_google_sheet1') { sheets.created.push(ctx.args.title); return { ok: true, data: { spreadsheetId: 'SHEET_1' } }; }
      if (id === 'svc:googlesheets.batch_update') { sheets.writes.push(ctx.args); return { ok: true, data: { totalUpdatedRows: ctx.args.values.length } }; }
      if (id === 'svc:googlesheets.batch_get') return { ok: true, data: { valueRanges: [{ values: [] }, { values: [] }] } };
      const data = await store.replay(id, argsHashOf(plainArgs(ctx?.args || {})));
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
  const alerts = { sent: [] as any[], runFinished: async (title: string, headline: string) => { alerts.sent.push({ title, headline }); return { sent: true, label: 'WhatsApp sent (template)' }; }, runFailed: async () => ({ sent: false }) };
  const budget = { checks: [] as string[], check: async (id: string) => { budget.checks.push(id); return { ok: true, spent: 0, ceiling: null, estimate: 1 }; }, pauseAgent: async () => undefined, pushAlert: async () => ({ sent: true }) };
  const knowledge = { card: async (id: string) => opts.cards?.[id] ?? null };

  const sources = new SourceFetchService(actions as any, knowledge as any);
  const agent = fakeAgent(opts.job);
  const social = new SocialAgentRunService(agent as any, actions as any, llm as any, documents as any, alerts as any, undefined, budget as any, undefined, knowledge as any, sources);
  const journal = new RunJournalService(prisma);
  const tokens = new WorkerTokenService(journal, agent as any);
  const controller = new WorkerController(journal, tokens, agent as any, actions as any, sources, social, llm as any, budget as any, alerts as any);

  return { prisma, store, calls, sheets, shaped, documents, alerts, budget, agent, social, sources, journal, tokens, controller, llm };
}

/**
 * A kit wired straight to the controller — what the worker runner will do over HTTP, minus the
 * process. The token is minted per spawn, exactly as it will be, and identity comes off it.
 */
export async function spawnKit(world: any, runId: string, agentId: string) {
  const spawn = await world.tokens.mint(runId, agentId);
  const req = { worker: { runId: spawn.runId, agentId: spawn.agentId, expiresAt: spawn.expiresAt } };
  const routes: Record<string, string> = { tool: 'tool', merge: 'merge', ai: 'ai', step: 'step', output: 'output', notify: 'notify', ask: 'ask', finish: 'finish' };
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
