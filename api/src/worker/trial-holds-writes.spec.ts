import { makeWorld, spawnKit, SampleFixture } from './worker-harness.testing';

/**
 * A TRIAL WRITES NOTHING — including through `kit.call` (BEA-1471).
 *
 * The owner asked a direct question: *"I think still we are guarding codex?"* Checking the answer
 * turned up something worse than a guard — a promise that was not true.
 *
 * His screen said, and my own code comment claimed, *"Nothing was saved and nothing was sent."* That
 * held for `kit.writeDocument` and `kit.notify` and for nothing else. Every program written since
 * BEA-1457 reaches services through `kit.call`, so a trial run really could have created a Notion
 * page and really could have sent a WhatsApp message while telling him it had not.
 *
 * Reads still happen — a trial is worth nothing if it shows him invented rows.
 */

const READ = 'svc:instagram.user_posts';
const WRITE = 'svc:notion.create_notion_page';

const job = () => ({
  id: 'ag1',
  name: 'Nightly summary',
  prompt: 'Keep every result as fetched.',
  tools: [READ],
  toolArgs: { [READ]: { actionId: READ, args: { handle: 'a' } } },
  outputDest: 'document',
  mode: 'run',
});

const SAMPLES: SampleFixture[] = [{ actionId: READ, args: { handle: 'a' }, data: { items: [{ id: 'p1' }] } }];

describe('what a trial really does', () => {
  it('holds back a WRITE and says so, instead of calling it', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1', { trial: true });

    const r: any = await kit.call(WRITE, { title: 'Today', parent_id: 'abc' });

    expect(r.held).toBe(true);
    expect(r.why).toContain('not really called');
    expect(r.why).toContain('Nothing was written and nothing was sent');
    // THE point: the vendor was never reached.
    expect(world.calls.some((c: any) => c.id === WRITE)).toBe(false);
  });

  it('still performs a READ, so he sees real rows', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1', { trial: true });

    const r: any = await kit.call(READ, { handle: 'a' });

    expect(r.ok).toBe(true);
    expect(r.held).toBeUndefined();
    expect(r.data).toEqual({ items: [{ id: 'p1' }] });
    expect(world.calls.some((c: any) => c.id === READ)).toBe(true);
  });

  it('says on the run that it held something back — never silently', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1', { trial: true });
    await kit.call(WRITE, {});
    expect(world.agent.steps.some((s: any) => /Held back/.test(String(s.label)))).toBe(true);
  });

  it('a REAL run is untouched — it writes as it always did', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    world.actions.succeed.add(WRITE);
    const { kit } = await spawnKit(world, 'run-1', 'ag1'); // no trial

    const r: any = await kit.call(WRITE, { title: 'Today' });

    expect(r.held).toBeUndefined();
    expect(world.calls.some((c: any) => c.id === WRITE)).toBe(true);
  });

  it('fails CLOSED — an action it cannot classify is treated as a write', async () => {
    // Wrong in this direction holds a read back in a trial, which is visible and annoying. Wrong the
    // other way sends a real message during a run that promised it would not.
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1', { trial: true });

    const r: any = await kit.call('svc:whatever.frobnicate_thing', {});

    expect(r.held).toBe(true);
    expect(world.calls).toHaveLength(0);
  });
});
