'use strict';
/**
 * `kit` v1 — the shared parts box every agent worker stands on.
 * BEA-1387, agent workers 2/10. Design: `specs/AGENT-WORKERS.md` §B, §C, §H.
 *
 * Plain JavaScript, no dependencies, no build step. It is CommonJS on purpose: Node reads the named
 * exports at the bottom, so a generated ESM worker can do
 *
 *     import { makeKit, installDeterminism } from './kit/kit.js';
 *
 * and the same file can be required by the app's own tests. This file is copied verbatim into a
 * worker's version folder at build time and pinned by `meta.json.kit`.
 *
 * Three things it is, and is not:
 *
 *  - **Every function is a thin call back into My Brain** (`/api/worker/*`). The paging, the
 *    de-duping, the merge rule, the shaping prompt and the sheet writer all live in the app, and the
 *    plan runner calls the same ones. Parity between a worker and the plan runner is by
 *    construction — a worker cannot drift from it by rewriting a loop.
 *  - **It never holds a key and never calls a vendor.** It carries a run-scoped token minted for
 *    this spawn, so the credit ceiling, the can't-undo gate and the `ToolCall` recorder all apply.
 *  - **Every effectful call is journalled**, keyed by its position in the call order (`seq`). A
 *    worker that pauses on a question EXITS and is re-run from the top: the calls it already made
 *    return their recorded answers — zero repeat fetches, zero repeat sheet writes, zero repeat
 *    messages. A call order that changes between replays fails loudly instead of repeating a step.
 */

const KIT_VERSION = '1';

/** Thrown by `kit.ask` when the owner has not answered yet: the worker must exit, not spin. */
class WorkerPaused extends Error {
  constructor(question, waitpointId) {
    super(`waiting for the owner: ${question}`);
    this.name = 'WorkerPaused';
    this.paused = true;
    this.question = question;
    this.waitpointId = waitpointId;
  }
}

/** Thrown when the app refuses a call, or the worker itself calls `kit.fail()`. */
class WorkerFailed extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'WorkerFailed';
    this.failed = true;
  }
}

/**
 * Build the kit for one spawn.
 *
 * `api`, `token`, `runId` and `seed` come from the environment the worker runner sets
 * (`MYBRAIN_API`, `MYBRAIN_TOKEN`, `MYBRAIN_RUN_ID`, `MYBRAIN_SEED`). `fetchImpl` is only for the
 * app's own tests, which drive the kit in-process against the real controller.
 */
function makeKit(opts) {
  const o = opts || {};
  const api = String(o.api || process.env.MYBRAIN_API || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(o.token || process.env.MYBRAIN_TOKEN || '');
  const runId = String(o.runId || process.env.MYBRAIN_RUN_ID || '');
  const seed = o.seed || parseSeed(process.env.MYBRAIN_SEED);
  const call = o.fetchImpl || httpCall(api, token);

  // The call order. Every effectful call takes the next number and keeps it, whatever it answers —
  // the position IS the identity of the call, so it may never depend on what came back.
  let seq = 0;
  const rand = mulberry32(seed.random >>> 0);

  const post = async (route, body) => {
    const answer = await call(route, body);
    if (answer && answer.error) throw new WorkerFailed(String(answer.error));
    return answer;
  };

  const kit = {
    version: KIT_VERSION,
    runId,

    /** How many calls this spawn has made — the tests count repeats with it. */
    calls: () => seq,

    // ---- fetching -----------------------------------------------------------------------------

    /**
     * One source of the job's plan, fetched whole: every page, de-duped on the item's own id, the
     * credit ceiling checked before each page, one `ToolCall` per page. A creators-first block is a
     * source too — it is named by the same source id, and the app runs the finder and the
     * per-creator calls. A worker has no database, so it never decides paging for itself.
     */
    async fetchSource(sourceId, o2) {
      const body = { seq: seq++, sourceId: String(sourceId) };
      if (o2 && o2.pages !== undefined) body.pages = o2.pages;
      const r = await post('tool', body);
      if (r.stop) throw new WorkerFailed(r.stop);
      return r;
    },

    /** One pinned call the plan has no source for. Same recorder, same gate, same ceiling. */
    async tool(actionId, args) {
      const r = await post('tool', { seq: seq++, actionId: String(actionId), args: args || {} });
      if (r.stop) throw new WorkerFailed(r.stop);
      return r;
    },

    /** Several sources' tables → one, by the app's own merge rule (a `source` column, de-duped on the id). */
    async merge(tables) {
      return post('merge', { tables });
    },

    // ---- shaping and judging -------------------------------------------------------------------

    /** The rows the way the owner asked — the app's own batched shaping step, never a prompt of ours. */
    async shape(table, o2) {
      const r = await post('ai', { seq: seq++, helper: 'social-shape', table, prompt: (o2 && o2.prompt) || '', header: (o2 && o2.header) || null });
      if (!r.ok) throw new WorkerFailed(`Could not shape the rows: ${r.error || 'the shaping model returned nothing'}`);
      return r;
    },

    /** A plain helper call, for judgement a worker cannot compile into rules. Allow-listed by the app. */
    async ai(helper, prompt, o2) {
      const r = await post('ai', { seq: seq++, helper: String(helper), prompt: String(prompt), maxTokens: (o2 && o2.maxTokens) || 1000 });
      if (!r.ok) throw new WorkerFailed(`the ${helper} model returned nothing`);
      return r.text;
    },

    // ---- output --------------------------------------------------------------------------------

    /** The rows → the job's Google Sheet: create, or append under the sheet's own columns. */
    async writeSheet(table, o2) {
      const r = await post('output', { seq: seq++, kind: 'sheet', table, title: (o2 && o2.title) || undefined, append: o2 ? o2.append : undefined });
      if (!r.ok) throw new WorkerFailed(r.error || 'the rows could not be written to the sheet');
      return r;
    },

    /** The result → Documents, where every other run's output lands. */
    async writeDocument(doc) {
      const r = await post('output', { seq: seq++, kind: 'document', title: doc.title, markdown: doc.markdown });
      if (!r.ok) throw new WorkerFailed(r.error || 'the document could not be saved');
      return r;
    },

    /** Tell the owner: WhatsApp (template first, Meta's real verdict, Telegram if refused) and/or Telegram. */
    async notify(where, what) {
      return post('notify', {
        seq: seq++,
        whatsapp: !!(where && where.whatsapp),
        telegram: !!(where && where.telegram),
        headline: what.headline,
        detail: what.detail,
        url: what.url,
        title: what.title,
      });
    },

    // ---- discipline ----------------------------------------------------------------------------

    /** One readable line on the run screen. Journalled, so a resumed run does not repeat its log. */
    async step(label, status, detail) {
      return post('step', { seq: seq++, label, status: status || 'done', detail });
    },

    /**
     * "Still moving." NOT journalled and NOT part of the call order: it is the stamp that tells the
     * stall watchdog a slow job is alive. The app checkpoints inside its own fetch and shape loops
     * already; this is for a worker's own milestones ("4 of 9 sources done").
     */
    async checkpoint(label) {
      return post('step', { label, kind: 'checkpoint' });
    },

    /**
     * Ask the owner, and stop. Throws `WorkerPaused` when there is no answer yet — the worker must
     * let it out and exit. The re-run gets the answer at this same position and carries on.
     */
    async ask(q) {
      const body = { seq: seq++, question: q.question, choices: q.choices || [], deadlineHours: q.deadlineHours || 12 };
      if (q.ifNoAnswer !== undefined) body.ifNoAnswer = q.ifNoAnswer;
      const r = await post('ask', body);
      if (r.waiting) throw new WorkerPaused(q.question, r.waitpointId);
      return r.answer;
    },

    /** Something is wrong that the worker cannot decide alone — `ask` with the run's own context. */
    async trouble(reason, q) {
      return kit.ask({
        question: `${reason}\n\n${(q && q.question) || 'What should I do?'}`,
        choices: (q && q.choices) || [],
        deadlineHours: (q && q.deadlineHours) || 12,
        ifNoAnswer: q && q.ifNoAnswer,
      });
    },

    /** End the run honestly. Nothing after this runs. */
    async fail(reason) {
      await post('finish', { status: 'failed', error: String(reason) });
      throw new WorkerFailed(String(reason));
    },

    /** The run is done: the result, and where it landed. */
    async finish(result) {
      return post('finish', { status: 'done', ...(result || {}) });
    },

    // ---- the frozen clock ------------------------------------------------------------------------

    /**
     * The moment this RUN started, recorded once and the same on every replay. A worker's "last 30
     * days" must not move under it while it waits for an answer.
     */
    now() { return seed.now; },
    /** Repeatable randomness from the run's recorded seed. */
    random() { return rand(); },
    /** A uuid drawn from the same seed — the same worker replayed makes the same ids. */
    uuid() {
      const hex = [];
      for (let i = 0; i < 32; i++) hex.push(Math.floor(rand() * 16).toString(16));
      hex[12] = '4';
      hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
      const s = hex.join('');
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    },
  };

  return kit;
}

/**
 * Point the worker's whole context at the kit's journalled clock and randomness — `Date.now`, `new
 * Date()`, `Math.random` and `crypto.randomUUID`. Determinism is enforced here, not hoped for: a
 * worker that reads the wall clock would take a different road on a replay and could repeat a step.
 *
 * The runner calls this before it loads a worker; the app's tests call it on a sandbox object.
 * Returns a function that puts everything back (the tests use it; a worker process just exits).
 */
function installDeterminism(kit, target) {
  const g = target || globalThis;
  const realNow = g.Date.now;
  const realRandom = g.Math.random;
  const realUuid = g.crypto && g.crypto.randomUUID;
  const RealDate = g.Date;

  // `new Date()` with no arguments is the same frozen moment; every other use of Date is untouched.
  function FrozenDate(...args) {
    if (!(this instanceof FrozenDate)) return new RealDate(kit.now()).toString();
    return args.length ? new RealDate(...args) : new RealDate(kit.now());
  }
  FrozenDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(FrozenDate, RealDate);
  FrozenDate.now = () => kit.now();

  g.Date = FrozenDate;
  g.Math.random = () => kit.random();
  if (g.crypto && typeof g.crypto.randomUUID === 'function') g.crypto.randomUUID = () => kit.uuid();

  return function restore() {
    g.Date = RealDate;
    g.Date.now = realNow;
    g.Math.random = realRandom;
    if (realUuid && g.crypto) g.crypto.randomUUID = realUuid;
  };
}

/** HTTP to the app. One shape: POST JSON, read JSON, a non-2xx is the app's own plain reason. */
function httpCall(api, token) {
  return async function call(route, body) {
    const res = await fetch(`${api}/api/worker/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-token': token },
      body: JSON.stringify(body || {}),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (!res.ok) {
      const why = (json && (json.message || json.error)) || `the app answered ${res.status}`;
      throw new WorkerFailed(Array.isArray(why) ? why.join('; ') : String(why));
    }
    return json || {};
  };
}

function parseSeed(raw) {
  try {
    const v = JSON.parse(String(raw || ''));
    if (v && typeof v.now === 'number') return { now: v.now, random: Number(v.random) || 1 };
  } catch { /* no seed in the environment */ }
  // No seed given: this spawn is not repeatable, and that is exactly what a replay would catch.
  return { now: Date.now(), random: 1 };
}

/** A small, fast, seeded PRNG — the same seed gives the same sequence, on any machine. */
function mulberry32(a) {
  let t = a >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

exports.KIT_VERSION = KIT_VERSION;
exports.makeKit = makeKit;
exports.installDeterminism = installDeterminism;
exports.WorkerPaused = WorkerPaused;
exports.WorkerFailed = WorkerFailed;
