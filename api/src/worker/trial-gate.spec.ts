import { makeWorld, spawnKit, SampleFixture } from './worker-harness.testing';
import { TrialService, whyNotCreatable } from './trial.service';
import { briefToAgentInput } from '../agent/brief';

/**
 * THE SECOND GATE (BEA-1408, "Brief First").
 *
 * *"Nine hours of your work is next to useless."* He had approved a **description** of an agent,
 * typed in a chat. A description can say anything; the form behind it silently dropped whatever it
 * had no box for, and he found out weeks later.
 *
 * So the last thing between a brief and a live agent is the program itself, run once, on his real
 * account, with everything it produces held back. These tests prove the holding back is real — not
 * a flag the worker could talk its way past — and that Create cannot happen without it.
 */

const post = (id: string) => ({ id, subject: `mail ${id}`, from: `p${id}@x.com`, url: `https://mail.x.com/${id}` });
const SRC = 'svc:instagram.search_hashtag';
const SAMPLES: SampleFixture[] = [{ actionId: SRC, args: { hashtag: 'x' }, data: { posts: [post('1'), post('2'), post('3')] } }];

const job = () => ({
  id: 'ag1',
  name: 'Nightly email summary',
  prompt: 'Keep every result as fetched.',
  tools: [SRC],
  toolArgs: { [SRC]: { actionId: SRC, args: { hashtag: 'x' } } },
  outputDest: 'sheet',
  sheetId: null,
  notifyWhatsApp: true,
  mode: 'run',
});

const MESSAGE = 'Last night · 31 mails\n\nWork (14)\n• Ravi — quote needs a reply';

/** A worker that does everything a real one does: fetch, check, write, tell him. */
async function fullWorker(kit: any) {
  const got = await kit.fetchSource(SRC);
  const merged = await kit.merge([{ id: got.label, table: got.table }]);
  kit.expect(merged);
  await kit.writeSheet(merged, { title: 'Nightly email summary' });
  await kit.notify({ whatsapp: true }, { headline: '3 rows', message: MESSAGE, title: 'Nightly email summary' });
  return kit.finish({ resultText: 'done' });
}

/** A world whose worker token says TRIAL. */
async function trialWorld() {
  const world = await makeWorld({ job: job(), samples: SAMPLES });
  const trials = new TrialService(world.prisma as any);
  (world.controller as any).trials = trials;
  return { world, trials };
}

describe('a trial writes nothing and sends nothing', () => {
  it('no sheet, no document, no message — on a run that does all three', async () => {
    const { world } = await trialWorld();
    const { kit } = await spawnKit(world, 'trial-1', 'ag1', { trial: true });
    await fullWorker(kit);

    expect(world.sheets.created).toEqual([]);
    expect(world.sheets.writes).toEqual([]);
    expect(world.documents.created).toEqual([]);
    expect(world.alerts.sent).toEqual([]);
    expect(world.budget.pushes).toEqual([]);
  });

  it('the same worker on a REAL run writes and sends, so the difference is the token and nothing else', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'real-1', 'ag1');
    await fullWorker(kit);

    expect(world.sheets.created.length + world.sheets.writes.length).toBeGreaterThan(0);
    expect(world.alerts.sent.length).toBe(1);
  });

  it('says so on the run, in plain words, at every step that held something back', async () => {
    const { world } = await trialWorld();
    const { kit } = await spawnKit(world, 'trial-2', 'ag1', { trial: true });
    await fullWorker(kit);

    const labels = world.agent.steps.map((s: any) => s.label).join(' | ');
    expect(labels).toContain('Nothing was written');
    expect(labels).toContain('It was NOT sent');
  });

  it('keeps the real rows and the real message for the screen', async () => {
    const { world, trials } = await trialWorld();
    const t = await trials.start({ areaId: 'a1', briefId: 'b1', briefVersion: 1 });
    await trials.attach(t.id, 'trial-3');
    const { kit } = await spawnKit(world, 'trial-3', 'ag1', { trial: true });
    await fullWorker(kit);

    const held = await trials.get(t.id);
    expect(held!.rowCount).toBe(3);
    expect(held!.rows.length).toBe(3);
    expect(held!.message).toBe(MESSAGE);
  });

  it('a worker cannot ask to leave trial mode — it rides on the token, not the body', async () => {
    const { world } = await trialWorld();
    const { kit } = await spawnKit(world, 'trial-4', 'ag1', { trial: true });
    const got = await kit.fetchSource(SRC);
    const merged = await kit.merge([{ id: got.label, table: got.table }]);
    kit.expect(merged);
    // Everything a worker could plausibly try to say.
    await (world.controller as any).output({ worker: { runId: 'trial-4', agentId: 'ag1', trial: true } }, { seq: 90, kind: 'sheet', title: 't', table: merged, trial: false, real: true });
    expect(world.sheets.created).toEqual([]);
    expect(world.sheets.writes).toEqual([]);
  });
});

describe('Create is impossible without a passing trial of THIS brief', () => {
  const approved = { version: 2, status: 'approved' };

  it('refuses when he has never run it', () => {
    expect(whyNotCreatable(approved, null)).toContain('Run it once first');
  });

  it('refuses when the brief was edited after the run he looked at', () => {
    const why = whyNotCreatable(approved, { briefVersion: 1, status: 'passed' } as any);
    expect(why).toContain('changed the brief after that run');
  });

  it('refuses while it is still going', () => {
    expect(whyNotCreatable(approved, { briefVersion: 2, status: 'running' } as any)).toContain('still running');
  });

  it('refuses a failed run, and says what went wrong', () => {
    const why = whyNotCreatable(approved, { briefVersion: 2, status: 'failed', error: 'Gmail said no' } as any);
    expect(why).toContain('did not work');
    expect(why).toContain('Gmail said no');
  });

  it('refuses an unapproved brief before anything else', () => {
    expect(whyNotCreatable({ version: 1, status: 'draft' }, null)).toContain('approve it first');
  });

  it('allows it only when a passing trial of this exact version exists', () => {
    expect(whyNotCreatable(approved, { briefVersion: 2, status: 'passed' } as any)).toBe('');
  });
});

describe('the job a brief becomes', () => {
  const brief = {
    name: 'Nightly email summary',
    sections: {
      want: [{ id: '1', text: 'Read all my important emails.', origin: 'owner' }],
      filter: [{ id: '2', text: 'Skip newsletters.', origin: 'owner' }, { id: '3', text: 'Killed idea.', origin: 'ai', struck: true }],
      output: [{ id: '4', text: 'Save the full list as a document.', origin: 'owner' }],
      sources: [], when: [], success: [], trouble: [], killed: [],
    },
    sources: [{ id: 'svc:gmail.fetch_emails', actionId: 'svc:gmail.fetch_emails', args: { query: 'newer_than:1d' } }],
    delivery: { whatsapp: true, telegram: false, messageText: MESSAGE },
  } as any;

  it('is created switched OFF and on the worker road', () => {
    const input = briefToAgentInput(brief);
    // Nothing fires on a schedule until he taps Create, and a brief's job was never meant for the
    // plan runner.
    expect(input.enabled).toBe(false);
    expect(input.useWorker).toBe(true);
    expect(input.origin).toBe('brief');
  });

  it('carries the sources so the kit can fetch them', () => {
    const input = briefToAgentInput(brief);
    expect(input.tools).toEqual(['svc:gmail.fetch_emails']);
    expect(input.toolArgs['svc:gmail.fetch_emails'].args).toEqual({ query: 'newer_than:1d' });
  });

  it('carries HIS words as the task, and leaves out what he killed', () => {
    const input = briefToAgentInput(brief);
    expect(input.prompt).toContain('Read all my important emails.');
    expect(input.prompt).toContain('Skip newsletters.');
    expect(input.prompt).not.toContain('Killed idea');
  });

  it('only writes to a sheet when he actually said sheet', () => {
    expect(briefToAgentInput(brief).outputDest).toBe('document');
    const withSheet = { ...brief, sections: { ...brief.sections, output: [{ id: '4', text: 'Put it in a Google Sheet.', origin: 'owner' }] } };
    expect(briefToAgentInput(withSheet).outputDest).toBe('sheet');
  });
});
