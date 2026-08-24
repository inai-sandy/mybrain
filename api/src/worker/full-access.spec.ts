import { makeWorld, spawnKit, SampleFixture } from './worker-harness.testing';
import { buildRequest } from './build-brief';
import { rawAnswer } from './worker.controller';
import { planFromAgent } from '../social/plan';

/**
 * FULL ACCESS (BEA-1457 / BEA-1458).
 *
 * The owner, 2026-08-24: *"Codex is also an AI coding agent … I tested in my local Codex, and it
 * worked in two seconds."* He was right, and the tally proved it — six failures in a row, none of
 * them Codex's. Every one was in the plumbing between Codex and his accounts.
 *
 * Two things caused that plumbing to keep needing a person:
 *
 *  1. **the app read the vendor's answer and threw the original away**, so a shape nobody had met
 *     could only ever be fixed in the app;
 *  2. **a per-job allow-list** (BEA-1401) meant a program that worked out mid-run that it needed one
 *     more call simply could not make it.
 *
 * Both are gone here. What is NOT gone is every guard that actually protects him — those live one
 * layer down in `ServiceActionsService`, never in this list, and the last two tests prove they still
 * fire on a call the old allow-list would have refused outright.
 *
 * Everything below the kit is real: the real controller, the real journal, the real credit guard,
 * the real gate. Only what leaves the building is faked.
 */

const POSTS = 'svc:instagram.user_posts';

/** Not in the job's toolbox and not in its plan — the exact call the old allow-list refused. */
const OUTSIDE = 'svc:tiktok.user_posts';

/**
 * A Gmail answer in the shape the app's general reader gets WRONG: the useful fields are buried in
 * `payload.headers` as name/value pairs. This is not hypothetical — it is why reading recipes were
 * invented, and it is exactly the case a program should now handle in three lines of its own code.
 */
const nestedAnswer = {
  messages: [
    { id: 'm1', payload: { headers: [{ name: 'Subject', value: 'Quote for 500 units' }, { name: 'From', value: 'Ravi at Supplier Co' }] } },
    { id: 'm2', payload: { headers: [{ name: 'Subject', value: 'Invoice for August' }, { name: 'From', value: 'Billing at Vendor Ltd' }] } },
  ],
};

const job = () => ({
  id: 'ag1',
  name: 'Nightly email summary',
  prompt: 'Keep every result as fetched.',
  tools: [POSTS],
  toolArgs: { [POSTS]: { actionId: POSTS, args: { max_results: 25 } } },
  outputDest: 'document',
  notifyWhatsApp: false,
  mode: 'run',
});

const SAMPLES: SampleFixture[] = [
  { actionId: POSTS, args: { max_results: 25 }, data: nestedAnswer },
  { actionId: OUTSIDE, args: { handle: 'b_home' }, data: { items: [{ id: 'e1', summary: 'Board call' }] } },
];

describe('the program sees the real answer and reads it itself (BEA-1457)', () => {
  it('hands back the payload the vendor really sent, not only the app’s reading of it', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    const r = await kit.call(POSTS, { max_results: 25 });

    expect(r.ok).toBe(true);
    // THE point of the whole issue: the untouched answer.
    expect(r.data).toEqual(nestedAnswer);
    expect(r.dataTruncated).toBeFalsy();
    expect(r.dataBytes).toBeGreaterThan(0);

    // And a program can now pull out the fields the app's general reader buries, in its own code,
    // with no recipe, no learned shape and nobody editing My Brain.
    const header = (m: any, name: string) => (m.payload?.headers || []).find((h: any) => h.name === name)?.value || null;
    const mails = (r.data?.messages || []).map((m: any) => ({ subject: header(m, 'Subject'), from: header(m, 'From') }));
    expect(mails).toEqual([
      { subject: 'Quote for 500 units', from: 'Ravi at Supplier Co' },
      { subject: 'Invoice for August', from: 'Billing at Vendor Ltd' },
    ]);
  });

  it('still hands back the app’s reading beside it, so nothing already built breaks', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    const r = await kit.tool(POSTS, { max_results: 25 });
    expect(r.table).toBeTruthy();
    expect(r.table.rows.length).toBe(2);
    // `kit.tool` and `kit.call` are the same door — one name is the old habit, the other the new one.
    expect(r.data).toEqual(nestedAnswer);
  });

  it('leaves the raw answer out when it is over the cap, and says so instead of failing', () => {
    // Driven directly, because the sample STORE has the same 2 MB cap: an answer this big is never
    // kept and so can never be replayed through the harness. The rule is what matters, and it lives
    // here. A real Instagram profile answer measured 436 KB (BEA-1395); this is well past 2 MB.
    const huge = { items: Array.from({ length: 24_000 }, (_, i) => ({ id: `i${i}`, text: 'x'.repeat(100) })) };

    const out = rawAnswer(huge);
    expect(out.dataTruncated).toBe(true);
    expect(out.data).toBeUndefined();
    // …and the byte count is still reported, so a worker can say WHY it only got the table.
    expect(out.dataBytes).toBeGreaterThan(2 * 1024 * 1024);

    // An ordinary answer rides through whole.
    expect(rawAnswer(nestedAnswer).data).toEqual(nestedAnswer);
    // And a call that returned nothing at all adds no fields, rather than a null `data` a worker
    // would have to tell apart from a real null.
    expect(rawAnswer(undefined)).toEqual({});
  });

  it('does not choke on an answer that cannot be serialised', () => {
    const loop: any = { a: 1 };
    loop.self = loop;
    // It says "truncated" rather than throwing inside the journal, where a throw would lose the run.
    expect(rawAnswer(loop)).toEqual({ dataTruncated: true });
  });
});

describe('any connected action, not just this job’s own (BEA-1457)', () => {
  it('makes a call that is in neither the job’s toolbox nor its plan', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    // Before this issue this threw "This job may not call svc:googlecalendar.events_list".
    const r = await kit.call(OUTSIDE, { handle: 'b_home' });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ items: [{ id: 'e1', summary: 'Board call' }] });
    // It is still recorded against this run and this job — full reach is not anonymity.
    const last = world.calls[world.calls.length - 1];
    expect(last.id).toBe(OUTSIDE);
    expect(last.ctx.runKind).toBe('worker');
    expect(last.ctx.agentId).toBe('ag1');
  });

  it('the credit ceiling still stops a call the allow-list used to stop', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    world.budget.check = async () => ({ ok: false, reason: 'Today’s Social credit ceiling (500) is reached.', spent: 500, ceiling: 500, estimate: 1 });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    // Reach is wide; spending is not. The guard runs BEFORE the call, so nothing was even attempted.
    await expect(kit.call(OUTSIDE, { handle: 'b_home' })).rejects.toThrow(/credit ceiling/i);
    expect(world.calls.some((c: any) => c.id === OUTSIDE)).toBe(false);
  });

  it('the can’t-undo gate still parks the run and asks him', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    world.actions.gated.add(OUTSIDE);
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    // A gated call does not fail the run — it pauses it, exactly as `kit.ask` does, and the worker
    // exits so the wait costs nothing.
    await expect(kit.call(OUTSIDE, { handle: 'b_home' })).rejects.toMatchObject({ paused: true });
  });
});

describe('finding out what exists, mid-run (BEA-1457)', () => {
  it('lists the connected services', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    const r = await kit.facts();
    expect(r.ok).toBe(true);
    expect(r.services.map((s: any) => s.slug)).toContain('gmail');
  });

  it('lists one service’s actions, and reads one action’s whole fact card', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    const list = await kit.facts({ service: 'gmail', q: 'send' });
    expect(list.actions.map((a: any) => a.id)).toContain('svc:gmail.send_email');

    const card = await kit.facts({ actionId: POSTS });
    expect(card.ok).toBe(true);
    expect(card.card).toContain('What it does');
  });

  it('says plainly when there is no such action, rather than throwing', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    const r = await kit.facts({ actionId: 'not-an-id' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nothing in the catalog/i);
  });

  it('takes NO place in the call order — so looking things up cannot break a resume', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    const before = kit.calls();
    await kit.facts();
    await kit.facts({ service: 'gmail', q: 'label' });
    await kit.facts({ actionId: POSTS });
    expect(kit.calls()).toBe(before);

    // This is what that buys: the FIRST effectful call still lands at position 0, whether the
    // program looked three things up first or nothing at all.
    await kit.call(POSTS, { max_results: 25 });
    const rows = await world.journal.list('run-1');
    expect(rows.filter((r: any) => r.seq >= 0).map((r: any) => r.seq)).toEqual([0]);
  });
});

describe('deep research, reachable again (BEA-1458)', () => {
  it('runs the app’s own budgeted research and returns the report', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    const r = await kit.research('What changed in EU battery rules this month?');

    expect(r.ok).toBe(true);
    expect(r.report).toContain('EU battery rules');
    expect(r.spend.sources).toBe(6);
    expect(world.research.calls).toEqual(['What changed in EU battery rules this month?']);
    // The owner reads the run, so the run says it happened.
    expect(world.agent.steps.some((s: any) => /Researched:/.test(s.label))).toBe(true);
  });

  it('a failed research run still reports what it spent, and does not end the program', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    world.research.fail = 'every search provider refused';
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    const r = await kit.research('anything');

    // Searches are paid for before anyone knows if the run will produce anything, so the spend
    // rides back on the failure rather than being written off silently.
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/refused/);
    expect(r.spend.searches).toBe(3);
  });

  it('is journalled, so a resumed run does not pay for the same research twice', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');
    await kit.research('one question');

    // The second spawn of the SAME run replays from the top — this is what makes an overnight wait
    // free, and research is the most expensive thing there is to repeat.
    const { kit: again } = await spawnKit(world, 'run-1', 'ag1');
    const r = await again.research('one question');

    expect(r.replayed).toBe(true);
    expect(world.research.calls.length).toBe(1);
  });
});

describe('thinking (BEA-1453/BEA-1457)', () => {
  it('parses a JSON reply for you', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES, shapeReply: () => '```json\n{"keep":["m1"]}\n```' });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    expect(await kit.think('which ones matter?', { json: true })).toEqual({ keep: ['m1'] });
  });

  it('gives back null when the reply was not JSON, instead of crashing the run', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES, shapeReply: () => 'I think all of them matter, honestly.' });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    // A model that ignores the format is a value to check, not an exception in the middle of a job.
    expect(await kit.think('which ones matter?', { json: true })).toBeNull();
  });
});

describe('the prompt Codex is sent (BEA-1457)', () => {
  const inputs = () => ({
    job: { id: 'ag1', name: 'Nightly email summary' },
    plan: planFromAgent(job()),
    cards: [],
    samples: [],
    kit: { version: '1', js: '// kit', doc: '# KIT' },
    version: 1,
    catalog: [{ slug: 'gmail', name: 'Gmail', actions: 27 }, { slug: 'instagram', name: 'Instagram', actions: 41 }],
  });

  it('tells Codex it can call anything connected, and shows it the shelf', async () => {
    const { brief } = buildRequest(inputs() as any);
    expect(brief).toContain('Any action the owner has connected');
    expect(brief).toContain('kit.call');
    expect(brief).toContain('kit.facts');
    // The shelf itself, not a shortlist chosen for it.
    expect(brief).toContain('`gmail` — Gmail (27 actions)');
    expect(brief).toContain('`instagram` — Instagram (41 actions)');
  });

  it('tells it the answer it gets is the real one, and that reading it is its job', async () => {
    const { brief } = buildRequest(inputs() as any);
    expect(brief).toContain('the answer GMAIL ACTUALLY SENT');
    expect(brief).toContain('Read it here, in this file');
    expect(brief).toContain('dataTruncated');
  });

  it('no longer asks for a recipe.json — that was the app reading on its behalf', async () => {
    const { brief, files } = buildRequest(inputs() as any);
    expect(brief).not.toContain('recipe.json');
    expect(Object.keys(files)).not.toContain('recipe.json');
  });

  it('names the two other doors', async () => {
    const { brief } = buildRequest(inputs() as any);
    expect(brief).toContain('kit.think');
    expect(brief).toContain('kit.research');
  });

  it('still says what stops it — the ceiling, the gate, the ledger', async () => {
    const { brief } = buildRequest(inputs() as any);
    expect(brief).toContain('daily credit ceiling');
    expect(brief).toContain('cannot be undone');
    expect(brief).toMatch(/Reads are never gated/);
  });
});
