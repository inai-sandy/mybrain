import { makeWorld, spawnKit, SampleFixture, OWNER_NUMBER } from './worker-harness.testing';
import { PostboxCallbackController } from '../contacts/postbox-callback.controller';
import { setOwnerReplyHandler } from '../contacts/owner-reply';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WorkerPaused } = require('./kit/kit.js');

/**
 * ASK AND WAIT, end to end (BEA-1392, agent workers 7/10 — `specs/AGENT-WORKERS.md` §H).
 *
 * The owner's own requirement: *"If something goes wrong, the worker has to send a WhatsApp
 * message, and it has to read my reply. There will be some big agents which take a lot of time to
 * execute."*
 *
 * The whole road is exercised, not a piece of it: a real worker on the real callback API parks and
 * exits, the question really goes through `OwnerAskService` (only the send itself is faked), his
 * reply arrives on the REAL `PostboxCallbackController` as Postbox really posts it, and the second
 * spawn replays its journal and finishes — repeating no fetch, no sheet write and no message.
 */

const post = (id: string) => ({ id, shortcode: `SC${id}`, caption: `post ${id}`, like_count: 3, url: `https://instagram.com/p/${id}` });
const HASHTAG = 'svc:instagram.search_hashtag';
const SAMPLES: SampleFixture[] = [{ actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, data: { posts: [post('p1'), post('p2')] } }];

const job = () => ({
  id: 'ag1',
  name: 'Smart Home Instagram',
  prompt: 'Columns id, caption, link.',
  tools: [HASHTAG],
  toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' } } },
  outputDest: 'sheet',
  sheetId: null,
  notifyWhatsApp: true,
  mode: 'run',
});

/** A worker that fetches, shapes, then asks the owner before it writes anything. */
async function askingWorker(kit: any) {
  const got = await kit.fetchSource(HASHTAG);
  const merged = await kit.merge([{ id: got.label, table: got.table }]);
  const shaped = await kit.shape(merged, { prompt: job().prompt });
  const answer = await kit.ask({
    question: `Write these ${shaped.rows.length} rows to the sheet?`,
    choices: ['Yes, write them', 'No, stop'],
    ifNoAnswer: 'Yes, write them',
  });
  if (answer !== 'Yes, write them') return kit.fail('You said not to write them.');
  const w = await kit.writeSheet({ columns: shaped.columns, rows: shaped.rows }, { title: 'Smart Home Instagram' });
  await kit.notify({ whatsapp: true }, { headline: `${shaped.rows.length} rows`, title: 'Smart Home Instagram' });
  await kit.finish({ resultText: `${shaped.rows.length} rows`, outputUrl: w.url });
  return w;
}

/** The real callback controller, with the world's own question road registered on it. */
function inboundRoad(world: any) {
  world.owner.onModuleInit();
  const prisma: any = {
    reminderMessage: { findFirst: async () => null, create: async () => undefined },
    deletedMessage: { findUnique: async () => null },
    contact: { findFirst: async () => null },
  };
  const ctrl = new PostboxCallbackController(prisma, { callbackKey: 'k' } as any, { onContactReply: async () => undefined } as any);
  return (from: string, text: string) => ctrl.callback({ kind: 'message', from, text, wamid: `wamid.${Math.random()}` }, 'k');
}

afterEach(() => setOwnerReplyHandler(null));

describe('a worker asks on WhatsApp and carries on when the owner replies', () => {
  it('parks, messages him, and costs nothing while it waits', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const first = await spawnKit(world, 'run1', 'ag1');
    await expect(askingWorker(first.kit)).rejects.toThrow(WorkerPaused);

    // The question really went to his phone, through the one owner road (template first, Meta's
    // verdict, Telegram fallback — BEA-1379), with its choices numbered and a tag to answer by.
    expect(world.alerts.asked).toHaveLength(1);
    expect(world.alerts.asked[0]).toMatchObject({ jobName: 'Smart Home Instagram', choices: ['Yes, write them', 'No, stop'] });
    expect(world.alerts.asked[0].question).toContain('Write these 2 rows');
    expect(world.alerts.asked[0].tag).toMatch(/^#[a-z0-9]{1,3}$/);
    expect(world.alerts.asked[0].path).toBe('/agent/runs/run1');

    // The run is parked the way a restart can survive, and the spawn's token is already dead.
    expect(world.agent.parked).toEqual([{ runId: 'run1', sessionId: 'worker' }]);
    expect(world.agent.waitpoints[0]).toMatchObject({ status: 'pending', askedVia: 'whatsapp', defaultValue: 'Yes, write them' });
    expect(world.tokens.liveCount()).toBe(0);
    // And nothing has happened in the world yet.
    expect(world.sheets.writes).toHaveLength(0);
    expect(world.alerts.sent).toHaveLength(0);
  });

  it('his reply two days later answers it, and the re-run repeats nothing', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const reply = inboundRoad(world);
    await expect(askingWorker((await spawnKit(world, 'run1', 'ag1')).kit)).rejects.toThrow(WorkerPaused);

    // Two days later, on the number he always writes from, answering by number.
    const res = await reply(OWNER_NUMBER, '1');
    expect(res).toMatchObject({ answered: true });
    expect(world.agent.waitpoints[0]).toMatchObject({ status: 'answered', answer: 'Yes, write them', answeredVia: 'whatsapp' });

    const w: any = await askingWorker((await spawnKit(world, 'run1', 'ag1')).kit);
    expect(world.calls.filter((c: any) => c.id === HASHTAG)).toHaveLength(1); // zero repeat fetches
    expect(world.shaped).toHaveLength(1); // zero repeat AI calls
    expect(world.sheets.writes).toHaveLength(1); // written exactly once
    expect(world.alerts.sent).toHaveLength(1); // told exactly once
    expect(w.url).toContain('SHEET_1');
    expect(world.agent.finished).toEqual([expect.objectContaining({ status: 'done' })]);
    // The run screen says what he chose, and where the answer came from.
    expect(world.agent.steps.map((s: any) => s.label).join(' | ')).toContain('Carrying on with your answer: Yes, write them');
  });

  it('"no" is his to give: the run stops and writes nothing', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const reply = inboundRoad(world);
    await expect(askingWorker((await spawnKit(world, 'run1', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    await reply(OWNER_NUMBER, '2');
    await expect(askingWorker((await spawnKit(world, 'run1', 'ag1')).kit)).rejects.toThrow(/You said not to write them/);
    expect(world.sheets.writes).toHaveLength(0);
    expect(world.agent.finished).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it("a contact's reply never touches the question, even while a worker is waiting", async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const reply = inboundRoad(world);
    await expect(askingWorker((await spawnKit(world, 'run1', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    await reply('918885551234', 'yes go ahead');
    expect(world.agent.waitpoints[0].status).toBe('pending');
    // And the worker parks again rather than reading someone else's words as an answer.
    await expect(askingWorker((await spawnKit(world, 'run1', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    expect(world.agent.waitpoints).toHaveLength(1); // asked once, never twice
  });

  it('the deadline: no answer in 12 hours takes the default, and the run SAYS so', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    await expect(askingWorker((await spawnKit(world, 'run1', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    // What `AgentService.sweepExpired()` does at the deadline: the question's own default is applied.
    await world.agent.timeout(world.agent.waitpoints[0].id);

    await askingWorker((await spawnKit(world, 'run1', 'ag1')).kit);
    expect(world.sheets.writes).toHaveLength(1);
    const said = world.agent.steps.map((s: any) => s.label).join(' | ');
    expect(said).toContain('No answer in 12 hours');
    expect(said).toContain('the default this question named');
  });

  it('kit.trouble asks the owner, and twelve hours of silence STOPS rather than carries on', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const trouble = async (kit: any) => kit.trouble('Instagram hashtag search has failed 6 times');
    await expect(trouble((await spawnKit(world, 'run9', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    expect(world.alerts.asked[0].question).toContain('failed 6 times');
    expect(world.agent.waitpoints[0].options).toEqual(['Carry on anyway', 'Stop the run']);
    expect(world.agent.waitpoints[0].defaultValue).toBe('Stop the run'); // silence is never permission
  });
});

describe('a can\'t-undo call parks the run and asks, instead of failing it', () => {
  const deleter = async (kit: any) => kit.tool('svc:github.delete_a_repository', { owner: 'inai-sandy', repo: 'old-notes' });

  it('parks on the gate, messages him, and makes the call only after his yes', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const reply = inboundRoad(world);
    world.actions.gated.add('svc:github.delete_a_repository');

    await expect(deleter((await spawnKit(world, 'run7', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    expect(world.alerts.asked[0].question).toContain('cannot be undone');
    expect(world.gates.pending[0].ctx).toMatchObject({ runId: 'run7', nodeId: 'worker:0' });

    await reply(OWNER_NUMBER, 'yes');
    expect(world.gates.settled[0]).toMatchObject({ runId: 'run7', decision: 'approved' });

    // He said yes, so the second spawn's call goes through — and the gate is not asked again.
    // (The real `ServiceActionsService` reads his recorded approval and lets the call past itself;
    // here the gate is simply lifted, which is the same thing from the worker's side.)
    world.actions.gated.delete('svc:github.delete_a_repository');
    world.actions.succeed.add('svc:github.delete_a_repository');
    const r = await deleter((await spawnKit(world, 'run7', 'ag1')).kit);
    expect(r.ok).toBe(true);
    expect(world.agent.waitpoints).toHaveLength(1);
  });

  it('twelve hours of silence is a NO — it stops, and it does not ask again (and again)', async () => {
    // The trap this test exists for: the gate's default ("No, stop") is written on the question, but
    // the timeout road has to settle the GATE too. If it only settled the waitpoint, the resumed
    // worker would meet the same gate, park again, and message him every twelve hours for ever.
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    inboundRoad(world); // registers the answer hook, exactly as the app does at boot
    world.actions.gated.add('svc:github.delete_a_repository');

    await expect(deleter((await spawnKit(world, 'run6', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    expect(world.alerts.asked).toHaveLength(1);
    expect(world.agent.waitpoints[0].defaultValue).toBe('No, stop');

    await world.agent.timeout(world.agent.waitpoints[0].id); // the deadline, taking the default
    expect(world.gates.settled[0]).toMatchObject({ decision: 'rejected' });

    await expect(deleter((await spawnKit(world, 'run6', 'ag1')).kit)).rejects.toThrow(/said no/i);
    expect(world.agent.waitpoints).toHaveLength(1); // asked once, ever
    expect(world.alerts.asked).toHaveLength(1); // and messaged once, ever
  });

  it('a no stops that step with his own decision, and never asks twice', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const reply = inboundRoad(world);
    world.actions.gated.add('svc:github.delete_a_repository');

    await expect(deleter((await spawnKit(world, 'run8', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    await reply(OWNER_NUMBER, 'no');
    expect(world.gates.settled[0].decision).toBe('rejected');

    await expect(deleter((await spawnKit(world, 'run8', 'ag1')).kit)).rejects.toThrow(/said no/i);
    expect(world.agent.waitpoints).toHaveLength(1);
    // Nothing was sent to the vendor on the second pass either.
    expect(world.calls.filter((c: any) => c.id === 'svc:github.delete_a_repository')).toHaveLength(1);
  });
});
