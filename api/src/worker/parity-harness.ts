/**
 * The parity harness (BEA-1393, agent workers 8/10 — `specs/AGENT-WORKERS.md` §G).
 *
 * The promotion guard needs one number: **do the rows move?** To get it honestly, both the live
 * worker and the repaired one are run against the same saved answers, in their own folders, and what
 * they produce is compared.
 *
 * This file writes that harness. Three decisions, all deliberate:
 *
 *  - **The app writes it, never Codex** — the same rule as `contract.json`. A ruler a model wrote can
 *    be exactly as wrong as the bug it is measuring, and a worker's own tests are written by the
 *    model whose repair we are judging.
 *  - **It is a fixed ruler, not the app.** Its `merge` and its shaping step are simple, deterministic
 *    stand-ins — NOT the app's `mergeTables()` and not the shaping model. That is on purpose: what is
 *    being measured is the WORKER's behaviour, and both versions are measured with the same ruler, so
 *    a difference in the answer can only have come from the worker. (Parity with the plan runner is a
 *    different question, and `kit-parity.spec.ts` is where it is answered.)
 *  - **It cannot reach anything.** There is no token and no API address in its environment, the kit is
 *    built with a local `fetchImpl`, and `fetch` itself is replaced with something that throws. A
 *    repair loop must be unable to spend a single credit, and this is where that is enforced rather
 *    than promised.
 */

/**
 * The file the harness is written to. It goes into a THROWAWAY COPY of the version folder, never
 * into the version itself — a live worker's folder is not something a measurement may edit, and both
 * versions have to be measured on the same saved answers, which the app sends with the request.
 */
export const PARITY_FILE = '.parity.mjs';

/** The one line the harness prints that the runner reads. */
export const PARITY_MARK = 'PARITY_RESULT ';

/**
 * The harness source. Pure — it takes nothing and depends on nothing but the folder it will sit in
 * (`worker.mjs`, `kit/kit.js`, `samples/`), so the same text runs against any version ever built.
 */
export function parityHarness(): string {
  return `// Written by My Brain to measure one worker version against another (BEA-1393). Not part of the
// worker: it is deleted after the measurement. It never touches the network.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { makeKit, installDeterminism } from './kit/kit.js';

const here = (p) => new URL(p, import.meta.url);
const readJson = (p) => { try { return JSON.parse(readFileSync(here(p), 'utf8')); } catch { return null; } };

// Nothing here may leave the folder. If a worker (or a test helper it drags in) tries, the parity
// run fails loudly instead of quietly spending the owner's credits.
globalThis.fetch = async () => { throw new Error('a parity run may never call anything — this worker tried to use fetch()'); };

const index = readJson('./samples/index.json') || { sources: [] };

/**
 * The saved answers, by source id. The FAILING answers are deliberately NOT read here: proving the
 * break is fixed is the worker's own tests' job, and this is the other question — whether the repair
 * changed what the agent gives back on the answers it normally gets.
 */
const answers = new Map();
for (const s of index.sources || []) {
  if (!s || !s.file) continue;
  const one = readJson('./' + s.file);
  if (one && one.answer) answers.set(String(s.sourceId), one.answer);
}

const calls = [];
const written = [];
let finished = null;

/** A source nothing was saved for answers as a genuinely empty source, never as an invented one. */
function toolAnswer(body) {
  const id = String(body.sourceId || body.actionId || '');
  const saved = answers.get(id);
  if (saved) return { ...saved, replayed: false };
  return { ok: true, label: id, credits: 0, empty: true, unrecognised: false, why: 'no saved answer for this source', stop: null, table: null };
}

/** A fixed union, so both versions are measured the same way. NOT the app's merge (see the note above). */
const KEY_FIELDS = ['id', 'pk', 'shortcode', 'aweme_id', 'video_id', 'post_id', 'url', 'link', 'permalink'];
function merge(tables) {
  const clean = (tables || []).filter((t) => t && t.table && (t.table.rows || []).length);
  if (!clean.length) return { columns: [], rows: [] };
  if (clean.length === 1) return { columns: clean[0].table.columns || [], rows: clean[0].table.rows || [] };
  const columns = ['source'];
  for (const t of clean) for (const c of t.table.columns || []) if (!columns.includes(c)) columns.push(c);
  const keyAt = columns.findIndex((c) => KEY_FIELDS.includes(String(c).toLowerCase()));
  const rows = [];
  const seen = new Set();
  for (const t of clean) {
    const cols = t.table.columns || [];
    for (const r of t.table.rows || []) {
      const row = columns.map((c) => (c === 'source' ? String(t.id || '') : r[cols.indexOf(c)]));
      if (keyAt !== -1) {
        const k = String(row[keyAt] ?? '');
        if (k && seen.has(k)) continue;
        if (k) seen.add(k);
      }
      rows.push(row);
    }
  }
  return { columns, rows };
}

const routes = {
  tool: (b) => toolAnswer(b),
  merge: (b) => merge(b.tables),
  // The shaping step is the model's, and a model is not a ruler: the rows are handed back exactly as
  // they came, for both versions alike.
  ai: (b) => (b.table ? { ok: true, columns: b.table.columns || [], rows: b.table.rows || [], note: 'parity: rows unchanged' } : { ok: true, text: '' }),
  step: () => ({ ok: true }),
  output: (b) => {
    written.push(b.kind === 'sheet' ? { columns: (b.table && b.table.columns) || [], rows: (b.table && b.table.rows) || [] } : { columns: ['markdown'], rows: [[String(b.markdown || '')]] });
    return { ok: true, url: 'https://parity.local/sheet', id: 'parity', created: true, skipped: 0, nothingNew: false, rows: ((b.table && b.table.rows) || []).length };
  },
  notify: () => ({ ok: true, whatsapp: { sent: true }, telegram: { sent: true } }),
  // A question cannot be answered here, so it is answered with its own default — the same road the
  // 12-hour deadline takes. A worker that waits for a person is not measurable, and pretending it
  // paused would make every version look identical.
  ask: (b) => ({ waiting: false, answer: b.ifNoAnswer !== undefined ? b.ifNoAnswer : (b.choices && b.choices[0]) || 'Carry on' }),
  finish: (b) => { finished = { status: b.status || 'done', error: b.error || null }; return { ok: true, status: b.status || 'done' }; },
};

const kit = makeKit({
  api: 'http://parity.invalid',
  token: '',
  runId: 'parity',
  seed: { now: 1_755_000_000_000, random: 7 },
  fetchImpl: async (route, body) => {
    calls.push(route);
    const fn = routes[route];
    if (!fn) throw new Error('no route ' + route);
    return fn(body || {});
  },
});
installDeterminism(kit);

function say(result) {
  process.stdout.write('\\n${PARITY_MARK}' + JSON.stringify(result) + '\\n');
}

const rowKey = (row) => createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 12);

let out = { ok: false, error: 'the worker never finished', rows: 0, columns: [], rowKeys: [], calls: [] };
try {
  if (!existsSync(here('./worker.mjs'))) throw new Error('there is no worker.mjs in this version');
  const mod = await import('./worker.mjs');
  if (typeof mod.run !== 'function') throw new Error('worker.mjs does not export run(kit)');
  await mod.run(kit);
  const table = written.length ? written[written.length - 1] : { columns: [], rows: [] };
  const failed = finished && finished.status === 'failed';
  out = {
    ok: !failed,
    error: failed ? finished.error : null,
    rows: table.rows.length,
    columns: table.columns.map(String),
    rowKeys: table.rows.map(rowKey),
    calls,
  };
} catch (e) {
  out = { ok: false, error: String((e && e.message) || e), rows: 0, columns: [], rowKeys: [], calls };
}
say(out);
`;
}

/** The harness's own line, out of whatever the process printed. */
export function readParity(stdout: string): { ok: boolean; error?: string | null; rows?: number; columns?: string[]; rowKeys?: string[]; calls?: string[] } | null {
  const lines = String(stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf(PARITY_MARK);
    if (at === -1) continue;
    try {
      return JSON.parse(lines[i].slice(at + PARITY_MARK.length));
    } catch {
      return null;
    }
  }
  return null;
}
