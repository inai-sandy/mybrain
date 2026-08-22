import { createHash } from 'crypto';
import { AgentPlan, PlanBlock, sourceLabel, sourceActionId } from '../social/plan';
import { ToolKnowledge } from '../tools/tool-knowledge.service';
import { cardText } from '../agent/thinking-builder';

/**
 * The build turn's brief (BEA-1390, agent workers 5/10 — `specs/AGENT-WORKERS.md` §C, §D).
 *
 * Everything here is PURE: a plan, its fact cards and its saved answers in, one folder's worth of
 * files and one brief out. Codex is handed that folder and writes `worker.mjs` + `worker.test.mjs`
 * inside it. Nothing in this file touches the network, the database or the disk, so the brief a
 * build turn sends can be read in a test exactly as Codex will read it.
 *
 * Two things it is careful about:
 *  - **no secrets ever land in a worker folder** — the run token is minted per spawn and lives only
 *    in the environment of the spawned process. Nothing here writes a key, an account or a cookie;
 *  - **the fixtures are real answers.** A worker's tests stand on saved `ToolSample`s (whole vendor
 *    answers, masked), turned into the exact shape the callback API returns. When there is no saved
 *    answer for a source yet, the brief SAYS so and names the fields the know-how card has observed
 *    — a made-up fixture that is known to be made up, never one pretending to be real.
 */

/** One saved answer, ready to be written into the worker's `samples/` folder. */
export type BuildSample = {
  sourceId: string;
  actionId: string;
  args: Record<string, any>;
  /** The `ToolSample` row this came from — pinned so the eviction sweep cannot take it away. */
  sampleId: string;
  capturedAt?: string | null;
  /** Exactly what `POST /api/worker/tool` answers for this source, built from the saved answer. */
  answer: { ok: boolean; label: string; credits: number; empty: boolean; why: string | null; stop: null; table: any };
  /** The credits are the card's typical cost, not a measured one — said out loud in `index.json`. */
  creditsEstimated: boolean;
};

export type BuildInputs = {
  job: { id: string; name?: string | null };
  plan: AgentPlan;
  cards: ToolKnowledge[];
  samples: BuildSample[];
  kit: { version: string; js: string; doc: string };
  version: number;
  previousVersion?: number | null;
  origin?: 'build' | 'rebuild';
  reason?: string | null;
};

export type BuildRequest = {
  brief: string;
  files: Record<string, string>;
  planHash: string;
  sampleIds: string[];
};

/**
 * The hash of the plan a worker was compiled from. Stable under key order (a plan is rebuilt from
 * the job's columns on every read, and object key order must not decide whether a worker is stale)
 * and blind to the things that do not change what the worker DOES: the job's name and the schedule
 * text are not in it, the actions, arguments, pages, shaping prompt, watch mode and output are.
 */
export function planHashOf(plan: AgentPlan): string {
  const shape = {
    sources: (plan.sources || []).map((s) => canonicalBlock(s)),
    merge: !!plan.merge,
    shape: plan.shape?.prompt || null,
    watch: plan.watch ? { mode: plan.watch.mode, threshold: plan.watch.threshold || null, condition: plan.watch.condition || null } : null,
    output: { kind: plan.output?.kind, sheetId: plan.output?.sheetId || null, append: !!plan.output?.append },
    notify: { whatsapp: !!plan.notify?.whatsapp, telegram: !!plan.notify?.telegram },
    mode: plan.mode,
  };
  return `sha256:${createHash('sha256').update(stable(shape)).digest('hex')}`;
}

function canonicalBlock(s: PlanBlock): any {
  if (s.kind === 'creators') {
    return {
      kind: 'creators',
      id: s.id,
      find: { actionId: s.find.actionId, args: s.find.args || {}, take: s.find.take },
      then: { actionId: s.then.actionId, argsFrom: s.then.argsFrom || {}, args: s.then.args || null, keepDays: s.then.keepDays ?? null },
    };
  }
  return { kind: 'source', id: s.id, actionId: s.actionId, args: s.args || {}, pages: s.pages };
}

/** JSON with every object's keys sorted — the same plan always hashes to the same thing. */
export function stable(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

/** A source id as a filename: `svc:instagram.search_profiles#2` → `svc_instagram.search_profiles-2`. */
export function sampleFileName(sourceId: string): string {
  const safe = String(sourceId).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return `samples/${safe || 'source'}.json`;
}

/** The whole build request: the folder's files and the brief Codex is given. */
export function buildRequest(inp: BuildInputs): BuildRequest {
  const planHash = planHashOf(inp.plan);
  const files: Record<string, string> = {
    'kit/kit.js': inp.kit.js,
    'kit/KIT.md': inp.kit.doc,
    'plan.json': JSON.stringify(inp.plan, null, 2),
  };

  const index: any = {
    builtAt: new Date().toISOString(),
    jobId: inp.job.id,
    version: inp.version,
    kit: inp.kit.version,
    planHash,
    note: 'Each entry is exactly what POST /api/worker/tool answers for that source, built from a saved vendor answer. Credits marked estimated come from the action\'s know-how card, not from that call.',
    sources: [] as any[],
  };

  const byId = new Map(inp.samples.map((s) => [s.sourceId, s]));
  for (const block of inp.plan.sources || []) {
    const sample = byId.get(block.id);
    const card = cardFor(inp.cards, sourceActionId(block));
    if (sample) {
      const file = sampleFileName(block.id);
      files[file] = JSON.stringify({ sourceId: sample.sourceId, actionId: sample.actionId, args: sample.args, sampleId: sample.sampleId, capturedAt: sample.capturedAt || null, answer: sample.answer }, null, 2);
      index.sources.push({
        sourceId: block.id,
        actionId: sample.actionId,
        kind: block.kind,
        file,
        sampleId: sample.sampleId,
        capturedAt: sample.capturedAt || null,
        rows: sample.answer?.table?.rows?.length ?? 0,
        columns: sample.answer?.table?.columns ?? [],
        creditsEstimated: sample.creditsEstimated,
      });
    } else {
      index.sources.push({
        sourceId: block.id,
        actionId: sourceActionId(block),
        kind: block.kind,
        file: null,
        why: 'no saved answer for this call yet — write the fixture from the fields below and mark it as made up',
        observedFields: (card?.fields || []).slice(0, 30).map((f) => `${f.path} (${f.kind})`),
      });
    }
  }
  files['samples/index.json'] = JSON.stringify(index, null, 2);

  return { brief: briefText(inp, planHash, index), files, planHash, sampleIds: inp.samples.map((s) => s.sampleId) };
}

function cardFor(cards: ToolKnowledge[], actionId: string): ToolKnowledge | undefined {
  return (cards || []).find((c) => c.actionId === actionId);
}

/** The plan in the owner's own terms — what the worker has to do, before any JSON. */
export function planInWords(plan: AgentPlan): string {
  const lines: string[] = [];
  plan.sources.forEach((s, i) => {
    const label = sourceLabel(s, plan.sources);
    if (s.kind === 'creators') {
      lines.push(`${i + 1}. **${s.id}** — creators first: find with \`${s.find.actionId}\` (${JSON.stringify(s.find.args)}), take the first ${s.find.take}, then \`${s.then.actionId}\` for each one${s.then.keepDays ? `, keeping the last ${s.then.keepDays} days` : ''}. ONE \`kit.fetchSource('${s.id}')\` does all of that.`);
    } else {
      lines.push(`${i + 1}. **${s.id}** — \`${s.actionId}\` ${JSON.stringify(s.args)}${s.pages > 1 ? `, ${s.pages} pages` : ''} (${label}). One \`kit.fetchSource('${s.id}')\`.`);
    }
  });
  lines.push(plan.merge ? `Then merge the ${plan.sources.length} tables with \`kit.merge\`.` : 'There is one source, so there is nothing to merge.');
  lines.push(plan.shape ? `Then shape the rows: \`kit.shape(table, { prompt })\` with the task below.` : 'There is NO AI step: the task is "keep every result as fetched", so the rows go out as they came in.');
  if (plan.watch) lines.push(`This job is a ${plan.watch.mode} — piece 6/7 territory; for now fetch, merge and write as a plain run and say so in a step.`);
  lines.push(
    plan.output.kind === 'sheet'
      ? `Then write the rows to the job's Google Sheet: \`kit.writeSheet(table, { title, append: ${!!plan.output.append} })\`${plan.output.sheetId ? ' (the job already has a sheet — the app knows which)' : ''}.`
      : 'Then save the result as a Document: `kit.writeDocument({ title, markdown })`.',
  );
  const where = [plan.notify.whatsapp ? 'WhatsApp' : '', plan.notify.telegram ? 'Telegram' : ''].filter(Boolean).join(' and ');
  lines.push(where ? `Then tell the owner on ${where}: \`kit.notify(…)\` with a one-line headline and the link.` : 'Nobody is told — there is no notify step.');
  lines.push('Then `kit.finish({ resultText, outputUrl })`.');
  return lines.join('\n');
}

function briefText(inp: BuildInputs, planHash: string, index: any): string {
  const { plan } = inp;
  const cards = (inp.cards || []).map((c) => cardText(c)).join('\n\n');
  const withSamples = index.sources.filter((s: any) => s.file);
  const without = index.sources.filter((s: any) => !s.file);

  return `# Build the worker for "${inp.job.name || inp.job.id}"

You are writing a small Node program that runs one agent job of My Brain. You are inside its version
folder (\`v${inp.version}\`) and everything you write goes here. ${inp.previousVersion ? `The job is on v${inp.previousVersion} today; it keeps running until this one passes its tests.` : 'This job has no worker yet — it runs on the plan runner until this one passes its tests.'}
${inp.reason ? `\nWhy this build: ${inp.reason}\n` : ''}
Write exactly two files:

- **\`worker.mjs\`** — the plan below, in code. It must \`export async function run(kit)\` and, when
  started by the worker runner, build a kit from the environment and run once. \`kit/KIT.md\` in this
  folder has the template and the whole API. Read it FIRST.
- **\`worker.test.mjs\`** — its tests, run with \`node --test worker.test.mjs\` from this folder.

Then run \`node --test worker.test.mjs\` yourself and fix what fails. **Green tests are the only way
this worker goes live.** If they cannot pass, leave them failing and say why in your final message —
the job stays on the road it is on, and lying about it is worse than failing.

## The plan

${planInWords(plan)}

The task, in the owner's words: ${JSON.stringify(plan.prompt || '')}
${plan.schedule ? `It runs ${plan.schedule.text}.` : 'It has no schedule — it runs when the owner taps Run, or when something starts it.'}
${plan.ceilingNote}

The whole plan is in \`plan.json\` (its hash is \`${planHash}\` — that is what makes this worker stale
when the owner edits the plan). Read the plan from your own code if you like, but the source ids are
fixed and may be written out literally.

## The parts box

\`kit/KIT.md\` — read it before you write a line. Everything the worker does goes through it. There
are **no dependencies to install**: Node ${'22'} built-ins and \`./kit/kit.js\`, nothing else. Never call a
vendor, never read a key, never write outside this folder.

## What each action really does

${cards || '(no fact cards were available for this plan — go by the plan and the saved answers)'}

## The saved answers your tests stand on

\`samples/index.json\` lists one entry per source. ${withSamples.length ? `${withSamples.length} of them ${withSamples.length === 1 ? 'has' : 'have'} a real saved answer in \`samples/\`: the file's \`answer\` field is **exactly** what \`kit.fetchSource(sourceId)\` returns for that source — the masked answer a real call gave, put through the app's own row builder.` : 'None of them has a real saved answer yet.'}
${without.length ? `\n${without.length} source${without.length === 1 ? '' : 's'} ${without.length === 1 ? 'has' : 'have'} no saved answer yet (${without.map((s: any) => s.sourceId).join(', ')}). Build a fixture for ${without.length === 1 ? 'it' : 'them'} from the fields listed in \`samples/index.json\`, and put a comment in the test saying the fixture is made up. Do not pretend it is real.` : ''}

Tests never touch the network. Drive the worker with a fake kit:

\`\`\`js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeKit } from './kit/kit.js';
import { run } from './worker.mjs';

const answers = JSON.parse(readFileSync(new URL('./samples/index.json', import.meta.url)));

function fakeKit(routes) {
  const calls = [];
  const kit = makeKit({
    api: 'http://test',
    token: 'test',
    runId: 'test-run',
    seed: { now: 1_755_000_000_000, random: 7 },
    fetchImpl: async (route, body) => { calls.push({ route, body }); return routes[route](body); },
  });
  return { kit, calls };
}
\`\`\`

\`fetchImpl(route, body)\` is the ONE seam: \`route\` is \`tool\`, \`merge\`, \`ai\`, \`output\`,
\`step\`, \`notify\` or \`finish\`, and whatever you answer is what the kit hands the worker. Answer
\`tool\` from the saved files, and \`merge\`/\`ai\`/\`output\`/\`notify\` with the shapes \`kit/KIT.md\`
documents.

## What the tests must prove

1. **The happy road**: every source is fetched exactly once, the tables are merged${plan.shape ? ', the rows are shaped' : ''}, the output is written once and the owner is told once — and the rows that reach the output are the rows from the saved answers.
2. **An empty source is not a failure**: a source answering \`{ ok: true, empty: true, table: null }\` is said in a step and the run carries on with the others.
3. **Every source empty**: nothing is written, nobody is messaged, and the run finishes honestly saying it found nothing.
4. **A refused call fails the run**: a \`tool\` answer with \`stop\` set (the credit ceiling) ends the run with that reason — the worker never writes a half table or invents rows.
5. **The call order never depends on what came back** — the same calls, in the same order, whatever the answers hold.

Use \`node:test\` and \`node:assert/strict\`. Keep the tests readable: an owner may open them.

## When you are done

Say in one short paragraph what the worker does, what its tests cover, and anything you could not
do. Do not write any other file, do not create a git repo, do not install anything.
`;
}
