import { makeWorld, spawnKit, SampleFixture } from './worker-harness.testing';

/**
 * The receipt bug, dead (BEA-1407).
 *
 * The owner's nightly agent WhatsApped him **"Nightly Important Email Summary finished · 5 rows
 * saved to Documents"** every night. He asked for a summary grouped into work, personal and
 * finance. He got a delivery note.
 *
 * The cause was not the model. `AlertsService.runFinished()` never passed `longBody`, so the only
 * thing a finished run could send was one line inside a WhatsApp template — and a template variable
 * may not contain a newline, so a grouped summary had nowhere to go. The road for it already existed
 * (`dailyMissDigest` uses it); nothing on the agent side ever took it.
 *
 * These tests run the REAL callback controller. What is faked is only the send itself.
 */

const post = (id: string) => ({ id, subject: `mail ${id}`, from: `p${id}@example.com`, url: `https://mail.example.com/${id}` });
const SRC = 'svc:instagram.search_hashtag';
const SAMPLES: SampleFixture[] = [{ actionId: SRC, args: { hashtag: 'x' }, data: { posts: [post('1'), post('2')] } }];

const job = () => ({
  id: 'ag1',
  name: 'Nightly email summary',
  prompt: 'Keep every result as fetched.',
  tools: [SRC],
  toolArgs: { [SRC]: { actionId: SRC, args: { hashtag: 'x' } } },
  outputDest: 'document',
  notifyWhatsApp: true,
  mode: 'run',
});

const MESSAGE = [
  'Last night · 31 mails',
  '',
  'Work (14)',
  '• Ravi — quote needs a reply today',
  '',
  'Personal (9)',
  '• Amma — call back',
  '',
  'Finance (8)',
  '• HDFC — statement ready',
].join('\n');

/** A worker that sends the message the brief actually asked for. */
async function summariser(kit: any) {
  const got = await kit.fetchSource(SRC);
  const merged = await kit.merge([{ id: got.label, table: got.table }]);
  kit.expect(merged);
  await kit.writeDocument({ title: 'Nightly email summary', markdown: '# rows' });
  await kit.notify({ whatsapp: true }, { headline: '31 mails · 14 work, 9 personal, 8 finance', message: MESSAGE, title: 'Nightly email summary' });
  return kit.finish({ resultText: 'done' });
}

describe('a finished run sends the message he approved, not a receipt', () => {
  it('the whole grouped summary reaches WhatsApp', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');
    await summariser(kit);

    const sent = world.alerts.sent[0];
    expect(sent).toBeTruthy();
    // The full message, in full, with its line breaks intact.
    expect(sent.longBody).toBe(MESSAGE);
    expect(sent.longBody).toContain('Work (14)');
    expect(sent.longBody).toContain('• Amma — call back');
    // And the one-line headline that rides inside the template has no newline in it — a template
    // variable containing one is refused by Meta.
    expect(sent.headline).not.toMatch(/[\n\t]/);
  });

  it('the run says the full message arrived', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');
    await summariser(kit);
    const labels = world.agent.steps.map((s: any) => s.label).join(' | ');
    expect(labels).toContain('Sent your full message on WhatsApp');
  });

  it('when Meta\'s window is shut it says so, and does NOT pretend the summary arrived', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    world.alerts.followUpDelivers = false;
    const { kit } = await spawnKit(world, 'run-3', 'ag1');
    await summariser(kit);

    const labels = world.agent.steps.map((s: any) => s.label).join(' | ');
    expect(labels).toContain('Only the short notice reached WhatsApp');
    expect(labels).toContain('last 24 hours');
    // The one thing that must never happen: a step that reads as success when he got a receipt.
    expect(labels).not.toContain('Sent your full message on WhatsApp');
  });

  it('a worker that sends no message behaves exactly as before', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-4', 'ag1');
    await (async (kit: any) => {
      const got = await kit.fetchSource(SRC);
      const merged = await kit.merge([{ id: got.label, table: got.table }]);
      kit.expect(merged);
      await kit.writeDocument({ title: 't', markdown: '# rows' });
      await kit.notify({ whatsapp: true }, { headline: '2 rows saved' });
      return kit.finish({ resultText: 'done' });
    })(kit);
    expect(world.alerts.sent[0].longBody).toBeUndefined();
    const labels = world.agent.steps.map((s: any) => s.label).join(' | ');
    expect(labels).not.toContain('Only the short notice');
  });

  it('Telegram gets the whole message — it has no template and no window', async () => {
    const world = await makeWorld({ job: { ...job(), notifyWhatsApp: false }, samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-5', 'ag1');
    await (async (kit: any) => {
      const got = await kit.fetchSource(SRC);
      const merged = await kit.merge([{ id: got.label, table: got.table }]);
      kit.expect(merged);
      await kit.writeDocument({ title: 't', markdown: '# rows' });
      await kit.notify({ telegram: true }, { headline: 'one line', message: MESSAGE });
      return kit.finish({ resultText: 'done' });
    })(kit);
    expect(world.budget.pushes.join('\n')).toContain('Work (14)');
  });
});
