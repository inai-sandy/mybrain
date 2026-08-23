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

/** How long a question waits before its `ifNoAnswer` is taken — the owner's own decision (§H). */
const ASK_DEADLINE_HOURS = 12;

/**
 * One line of the worker's own protocol on stdout — the runner reads `{type:'result'}` off it and
 * treats it as the worker's last word (BEA-1389). Silent wherever there is no stdout to write to
 * (the app's own tests build the kit in-process).
 */
function say(line) {
  try {
    if (typeof process !== 'undefined' && process.stdout && typeof process.stdout.write === 'function') {
      process.stdout.write(`${JSON.stringify(line)}\n`);
    }
  } catch {
    // Saying it is best-effort: a broken pipe must never turn a parked run into a failed one.
  }
}

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
 * Thrown by `kit.expect()` when the rows do not match what this job's `contract.json` says a good
 * answer looks like (BEA-1391, §E). It carries a sentence the owner can read — "fetched 90 answers,
 * recognised 0 rows" — because the run screen is where this lands.
 */
class ContractError extends Error {
  constructor(reason, facts) {
    super(reason);
    this.name = 'ContractError';
    this.failed = true;
    this.contract = true;
    this.facts = facts || null;
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

  // What this job's contract says a good answer is (BEA-1391 §E). Given by the caller (the app's own
  // tests) or read off `contract.json` beside this folder, which the build turn always writes.
  // A `contract.json` that EXISTS and cannot be read is not "no contract" — it is a broken worker,
  // and it says so at the first check instead of quietly running unchecked.
  const loaded = o.contract !== undefined ? { contract: normaliseContract(o.contract), error: null } : loadContract();
  const contract = loaded.contract;
  const contractError = loaded.error;
  // What every source really answered — remembered by the kit, so `kit.expect()` cannot be handed a
  // story about the fetch that does not match what happened. A replayed call returns its recorded
  // value, so the memory rebuilds identically on a resume.
  const fetches = [];
  // The last PASSING check, and the rows it passed. A bare "expect was called once" would let a
  // swallowed `ContractError`, or a check of some other table, still reach the output.
  let passed = null;

  const post = async (route, body) => {
    const answer = await call(route, body);
    if (answer && answer.error) throw new WorkerFailed(String(answer.error));
    // The app parked the run and asked the owner something (a can't-undo call it will not make
    // without a yes). The worker must EXIT, exactly as it does for `kit.ask` — the answer arrives
    // hours later and the next spawn replays to here for free.
    if (answer && answer.paused) throw new WorkerPaused(answer.question || 'the owner has to approve this', answer.waitpointId);
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
    /**
     * Fetch one source. `o2.recipe` is THIS tool's own reading recipe (BEA-1415) — the app applies
     * it to the answer it already holds, so the raw answer never leaves the app. A recipe that names
     * a path the answer does not have, or that would drop rows, is refused and the general reader
     * takes over; the run says which happened, either way.
     */
    async fetchSource(sourceId, o2) {
      const body = { seq: seq++, sourceId: String(sourceId) };
      if (o2 && o2.pages !== undefined) body.pages = o2.pages;
      if (o2 && o2.recipe) body.recipe = o2.recipe;
      const r = await post('tool', body);
      if (r.stop) throw new WorkerFailed(r.stop);
      remember(String(sourceId), r);
      return r;
    },

    /** One pinned call the plan has no source for. Same recorder, same gate, same ceiling. */
    async tool(actionId, args) {
      const r = await post('tool', { seq: seq++, actionId: String(actionId), args: args || {} });
      if (r.stop) throw new WorkerFailed(r.stop);
      remember(String(actionId), r);
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
      guardChecked(table);
      const r = await post('output', { seq: seq++, kind: 'sheet', table, title: (o2 && o2.title) || undefined, append: o2 ? o2.append : undefined });
      if (!r.ok) throw new WorkerFailed(r.error || 'the rows could not be written to the sheet');
      return r;
    },

    /** The result → Documents, where every other run's output lands. */
    async writeDocument(doc) {
      // A document is written from prose, not from a table, so the rows cannot be matched — but the
      // check must still have happened and passed.
      guardChecked();
      const r = await post('output', { seq: seq++, kind: 'document', title: doc.title, markdown: doc.markdown });
      if (!r.ok) throw new WorkerFailed(r.error || 'the document could not be saved');
      return r;
    },

    /**
     * Tell the owner: WhatsApp (template first, Meta's real verdict, Telegram if refused) and/or
     * Telegram.
     *
     * `what.message` is the WHOLE message the brief asked for — many lines, written out as it
     * should arrive. `what.headline` is the one line that rides inside the WhatsApp template, which
     * may not contain newlines. Give both: the headline always arrives, the full message arrives
     * when Meta's 24-hour window allows and the run says plainly which happened.
     */
    async notify(where, what) {
      // Telling the owner "here are your rows" is an output too — the same check stands in front of it.
      guardChecked();
      return post('notify', {
        seq: seq++,
        whatsapp: !!(where && where.whatsapp),
        telegram: !!(where && where.telegram),
        headline: what.headline,
        detail: what.detail,
        message: what.message,
        url: what.url,
        title: what.title,
      });
    },

    // ---- discipline ----------------------------------------------------------------------------

    /** What this job's `contract.json` says a good answer looks like. Null when there is none. */
    contract,

    /**
     * Check the rows against the contract — **before the output step, every time** (BEA-1391 §E).
     *
     * Answers `{ ok:true, rows, empty }` when they pass, and throws `ContractError` with a sentence
     * the owner can read when they do not. Free and local: no call, no credits, no place in the call
     * order, so a replay checks the same rows and reaches the same verdict.
     *
     * The one judgement it makes that nothing else can: **0 rows out of an answer that was not empty
     * is a failure** (the BEA-1377 run: 90 answers fetched, 0 rows recognised, an empty sheet
     * written, success reported), while 0 rows because every source genuinely had nothing is a fine
     * run that finishes `done` — exactly as the plan runner has always behaved.
     */
    expect(table, c) {
      if (contractError) throw new WorkerFailed(contractError);
      // A contract given here that is not a contract falls back to the folder's own, rather than
      // turning the check off: `kit.expect(rows, undefined)` may never mean "check nothing".
      const use = (c === undefined ? contract : normaliseContract(c)) || contract;
      const t = asTable(table);
      passed = null;
      if (!use) return { ok: true, rows: t.rows.length, empty: !t.rows.length };
      const verdict = checkContract(t, use, fetches, seed.now);
      if (!verdict.ok) throw new ContractError(verdict.reason, { rows: verdict.rows, sources: fetches.slice() });
      passed = fingerprint(t);
      return verdict;
    },

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
     *
     * The question goes to his phone on WhatsApp with its choices NUMBERED ("reply 1, 2 or 3"), and
     * he may answer in words too. `deadlineHours` defaults to 12 (his own decision): after that the
     * run carries on with `ifNoAnswer` and says so on the run — or, when the question named no
     * default, it stops honestly. A question is never left open for ever.
     */
    async ask(q) {
      const body = { seq: seq++, question: q.question, choices: q.choices || [], deadlineHours: q.deadlineHours || ASK_DEADLINE_HOURS };
      if (q.ifNoAnswer !== undefined) body.ifNoAnswer = q.ifNoAnswer;
      const r = await post('ask', body);
      if (r.waiting) {
        // Say WHY this process is about to exit, before it does (BEA-1395). The runner reads one
        // `{type:'result'}` line off stdout and, without it, a clean exit reads as `done` — so the
        // app finished the run and cancelled the very question the owner had just been asked. The
        // acceptance run met exactly that: a real question on his phone that could never be answered.
        say({ type: 'result', status: 'waiting', rows: null, waitpointId: r.waitpointId || null });
        throw new WorkerPaused(q.question, r.waitpointId);
      }
      return r.answer;
    },

    /**
     * Something is wrong that the worker cannot decide alone — the owner's own case: *"something is
     * not working, it has to trigger a WhatsApp"*. It is `kit.ask` with the trouble said first and a
     * safe pair of choices, so a worker never has to word this well itself.
     *
     * The default when nobody answers is **Stop**, on purpose: something is already wrong, and
     * twelve hours of silence is not permission to carry on regardless.
     */
    async trouble(reason, q) {
      const choices = (q && q.choices && q.choices.length ? q.choices : ['Carry on anyway', 'Stop the run']);
      const dflt = q && q.ifNoAnswer !== undefined ? q.ifNoAnswer : choices[choices.length - 1];
      const answer = await kit.ask({
        question: `${reason} — ${(q && q.question) || 'what should I do?'}`,
        choices,
        deadlineHours: (q && q.deadlineHours) || ASK_DEADLINE_HOURS,
        ifNoAnswer: dflt,
      });
      return answer;
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

  /** What one source answered, kept for `kit.expect` — never what the worker says about it. */
  function remember(id, r) {
    const rows = (r && r.table && Array.isArray(r.table.rows) && r.table.rows.length) || 0;
    fetches.push({
      id,
      label: (r && r.label) || id,
      // The plan runner's own rule, to the letter (`runPlan`: `out.empty || (out.why && mode ===
      // 'run')`): a source the vendor had nothing for, AND a source that fetched fine and kept
      // nothing (every post older than the window) are both EMPTY sources — a quiet day, not a
      // failure. Only the tripwire below takes that back.
      empty: !!(r && (r.empty || (r.why && !rows))),
      // The tripwire (BEA-1377): the calls succeeded and carried data, and no shape here read a
      // single row out of it. That is OUR bug, so it is NOT an empty source, whatever else it says.
      unrecognised: !!(r && r.unrecognised),
      why: (r && r.why) || null,
      rows,
    });
  }

  /**
   * A worker with a contract may not write or send anything it has not checked. Codex writes the
   * call, and a forgotten `kit.expect()` — or one whose `ContractError` was swallowed, or one run on
   * some other table — would put the whole design back where BEA-1377 found it. So the kit checks
   * three things itself rather than trusting the generated code to remember:
   * a contract that could be read, a check that PASSED, and a check of the very rows going out.
   */
  function guardChecked(table) {
    if (contractError) throw new WorkerFailed(contractError);
    if (!contract) return;
    if (!passed) {
      throw new WorkerFailed('This worker has a contract and these rows did not pass it — call kit.expect(table) before writing or sending anything, and let a ContractError out. (contract.json says what a good answer looks like.)');
    }
    if (table !== undefined && fingerprint(asTable(table)) !== passed) {
      throw new WorkerFailed('These are not the rows kit.expect() checked — check the very rows you are about to write.');
    }
  }

  return kit;
}

/** The contract as it is written in `contract.json`, with every field made safe to read. */
function normaliseContract(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  const num = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
  return {
    minRows: Math.max(0, num(raw.minRows, 1)),
    minFetched: raw.minFetched === null || raw.minFetched === undefined ? null : Math.max(0, num(raw.minFetched, 0)),
    maxRows: Math.max(1, num(raw.maxRows, 5000)),
    columns: list(raw.columns),
    mustHave: list(raw.mustHave),
    freshnessDays: raw.freshnessDays ? num(raw.freshnessDays, null) : null,
    allowEmptyWhen: raw.allowEmptyWhen === undefined || raw.allowEmptyWhen === null ? 'every source returned an empty answer' : String(raw.allowEmptyWhen),
  };
}

/**
 * `contract.json` sits beside this kit folder, written by the build turn.
 *
 * **No file** is "nothing to check" — the app's own tests load this kit, and a worker built before
 * contracts existed has none. **A file that cannot be read** is the opposite: it is a broken worker,
 * and it must fail loudly at the first check, because silently running unchecked is exactly the hole
 * this piece closes.
 */
function loadContract() {
  // eslint-disable-next-line
  const { readFileSync } = require('fs');
  // eslint-disable-next-line
  const { join } = require('path');
  const file = join(__dirname, '..', 'contract.json');
  let raw = null;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { contract: null, error: null }; // no contract in this folder
    return { contract: null, error: `This worker's contract.json could not be read (${String((e && e.message) || e).slice(0, 160)}), so nothing can be checked — the run stopped instead of writing something nobody checked.` };
  }
  let parsed = null;
  try {
    parsed = normaliseContract(JSON.parse(raw));
  } catch (e) {
    return { contract: null, error: `This worker's contract.json is not readable JSON (${String((e && e.message) || e).slice(0, 160)}) — the run stopped instead of writing something nobody checked.` };
  }
  if (!parsed) return { contract: null, error: 'This worker\'s contract.json does not hold a contract — the run stopped instead of writing something nobody checked.' };
  return { contract: parsed, error: null };
}

/**
 * The rows a check passed, in a form the next write can be compared against: the columns, how many
 * rows, and the ends of the table. Cheap on a big table, and enough to catch "checked one table,
 * wrote another".
 */
function fingerprint(t) {
  const rows = t.rows || [];
  const ends = rows.length ? JSON.stringify([rows[0], rows[rows.length - 1]]).slice(0, 500) : '';
  return `${(t.columns || []).join('|')}#${rows.length}#${ends}`;
}

/** Rows as they cross into `expect`: a table, an array of arrays, or an array of plain objects. */
function asTable(t) {
  if (Array.isArray(t)) {
    const columns = [];
    const rows = [];
    for (const r of t) {
      if (Array.isArray(r)) { rows.push(r); continue; }
      if (r && typeof r === 'object') {
        for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
        rows.push(r);
      }
    }
    // Rows given as objects are turned into cells under the columns they share.
    const cells = rows.map((r) => (Array.isArray(r) ? r : columns.map((c) => r[c])));
    return { columns, rows: cells };
  }
  const columns = t && Array.isArray(t.columns) ? t.columns.map((c) => String(c)) : [];
  const rows = t && Array.isArray(t.rows) ? t.rows.filter((r) => Array.isArray(r) || (r && typeof r === 'object')) : [];
  return { columns, rows: rows.map((r) => (Array.isArray(r) ? r : columns.map((c) => r[c]))) };
}

/** At least half the rows must carry a `mustHave` column, or the column is not really there. */
const MUST_HAVE_MIN_SHARE = 0.5;
/** A column name that reads like a date, for the freshness check. */
const DATE_COLUMN_RE = /(^|_)(date|time|timestamp|taken_at|posted|published|created|updated)/i;

/**
 * The whole judgement, pure and exported so the app's own tests can drive it without a worker.
 *
 * Order matters: the tripwire first, because "0 rows" from an answer that had something in it must
 * never be excused by `allowEmptyWhen`. That is the difference between the BEA-1377 failure and a
 * genuinely quiet day, and it is the whole point of this piece.
 */
function checkContract(table, contract, sources, now) {
  const rows = table.rows || [];
  const columns = table.columns || [];
  const at = typeof now === 'number' ? now : Date.now();
  const list = sources || [];

  if (!rows.length) {
    const broken = list.filter((s) => s.unrecognised);
    if (broken.length) {
      const why = broken.map((s) => `${s.why || 'the answer carried data but no rows were recognised'}${list.length > 1 ? ` (${s.label})` : ''}`).join('; ');
      return no(`${cap(why)}. Nothing was written: this is not an empty day at the vendor, it is a bug here.`, rows.length);
    }
    const answered = list.filter((s) => !s.empty);
    if (answered.length) {
      const who = answered.map((s) => s.label).join(', ');
      return no(`Nothing usable came back: ${answered.length} source${answered.length === 1 ? '' : 's'} answered (${who}) but recognised 0 rows. Nothing was written.`, rows.length);
    }
    if (!list.length) return no('Nothing was fetched at all, so there is nothing to write.', rows.length);
    if (String(contract.allowEmptyWhen).toLowerCase() === 'never') {
      return no(`Every source came back empty, and this job says finding nothing is never all right.`, rows.length);
    }
    // Every source genuinely had nothing: the run finishes done with 0 rows, exactly as the plan
    // runner's `nothingFound()` has always done. Not a failure — the vendor was asked and said no.
    return { ok: true, rows: 0, empty: true, why: `every source came back empty (${list.map((s) => s.label).join(', ')})` };
  }

  // How many were FETCHED, before any filtering (BEA-1410). His sentence was "at least 10 emails
  // read", and a run that read 15 and kept the 5 that mattered was failed for keeping 5 — while
  // doing exactly what he asked. Reading and keeping are different numbers.
  const fetched = list.reduce((n, s) => n + (Number(s.rows) || 0), 0);
  if (contract.minFetched && fetched < contract.minFetched) {
    return no(`Only ${fetched} came back from the sources, and this job needs to go through at least ${contract.minFetched}. Nothing was written.`, rows.length);
  }

  if (rows.length < contract.minRows) {
    return no(`Only ${rows.length} row${rows.length === 1 ? '' : 's'} came through, and this job needs at least ${contract.minRows}. Nothing was written.`, rows.length);
  }
  if (rows.length > contract.maxRows) {
    return no(`${rows.length} rows is more than the ${contract.maxRows} this job should ever produce — something ran away, so nothing was written.`, rows.length);
  }

  const missing = contract.columns.filter((c) => !columns.some((have) => sameName(have, c)));
  if (missing.length) {
    return no(`The rows are missing the column${missing.length === 1 ? '' : 's'} this job asks for: ${missing.join(', ')} (it has ${columns.join(', ') || 'no columns'}). Nothing was written.`, rows.length);
  }

  for (const need of contract.mustHave) {
    const i = columns.findIndex((c) => sameName(c, need));
    if (i === -1) return no(`The rows have no ${need} column at all. Nothing was written.`, rows.length);
    const filled = rows.filter((r) => notBlank(r[i])).length;
    if (filled < Math.ceil(rows.length * MUST_HAVE_MIN_SHARE)) {
      return no(`Only ${filled} of ${rows.length} rows have a ${need} — that column is empty in most rows, so the rows are not usable. Nothing was written.`, rows.length);
    }
  }

  if (contract.freshnessDays) {
    const i = columns.findIndex((c) => DATE_COLUMN_RE.test(String(c)));
    if (i !== -1) {
      const stamps = rows.map((r) => whenOf(r[i])).filter((t) => t !== null);
      const cutoff = at - contract.freshnessDays * 24 * 60 * 60 * 1000;
      if (stamps.length && !stamps.some((t) => t >= cutoff)) {
        const newest = new Date(Math.max.apply(null, stamps)).toISOString().slice(0, 10);
        return no(`Every row is older than the last ${contract.freshnessDays} days (the newest is from ${newest}). Nothing was written.`, rows.length);
      }
    }
  }

  return { ok: true, rows: rows.length, empty: false };
}

function no(reason, rows) { return { ok: false, reason, rows }; }
function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
function sameName(a, b) {
  const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return !!n(a) && n(a) === n(b);
}
function notBlank(v) {
  if (v === null || v === undefined) return false;
  return String(v).trim() !== '';
}

/** A cell as a moment: epoch seconds, epoch milliseconds, or anything `Date` can read. */
function whenOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e11 ? n : n * 1000;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
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
exports.ASK_DEADLINE_HOURS = ASK_DEADLINE_HOURS;
exports.makeKit = makeKit;
exports.installDeterminism = installDeterminism;
exports.WorkerPaused = WorkerPaused;
exports.WorkerFailed = WorkerFailed;
exports.ContractError = ContractError;
exports.checkContract = checkContract;
exports.normaliseContract = normaliseContract;
