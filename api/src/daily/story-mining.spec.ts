import { StoryMiningService } from './story-mining.service';

/**
 * The promises of deep story mining (BEA-1051):
 *  - one read proposes every section, nothing is created until applied,
 *  - a person is NEVER guessed — exact contact match or unlinked,
 *  - already-logged work is not re-proposed,
 *  - applying goes through the real doors (tasks, chases, promises, Lab).
 */
/** One read is TWO calls now: the work half and the day half, running side by side. (BEA-1166) */
const CALLS_PER_READ = 2;

const RICH = JSON.stringify({
  done: [{ title: 'Fixed the QC checklist', category: 'Factory' }],
  todos: [{ title: 'Order solder paste', category: 'Factory', note: 'before Monday', priority: 'high' }],
  delegations: [
    { person: 'Madhuri', title: 'Send the Focus ERP report', chase: true },
    { person: 'Someone New', title: 'Paint the stall banners', chase: true },
  ],
  myReminders: [{ title: 'Renew the insurance', date: '2026-07-30' }],
  promises: [{ to: 'Srikar', what: 'Pay the pending invoice', date: '2026-07-25' }],
  emotions: { lifted: ['EMO demo went well'], drained: ['late-night rework'], energy: 70, worry: 40, feeling: 'Tired but proud.' },
  events: [{ at: 'morning', title: 'At the factory checking QC' }, { at: 'evening', title: 'EMO testing at home' }],
  lessons: ['Late-night rework always eats the next morning'],
});

function make(llmReply: string | null, opts: { existingTitles?: string[]; mined?: string | null; minedHash?: string | null; rawText?: string } = {}) {
  const createdTasks: any[] = [];
  const doneTasks: any[] = [];
  const chases: any[] = [];
  const dayEvents: any[] = [];
  const findings: any[] = [];
  const storyUpdates: any[] = [];
  let seq = 0;
  const prisma: any = {
    story: {
      findFirst: async () => ({
        id: 'st1',
        day: '2026-07-22',
        rawText: opts.rawText ?? 'A long real diary entry about the whole day at the factory and beyond.',
        mined: opts.mined ?? null,
        minedHash: opts.minedHash ?? null,
      }),
      update: async ({ data }: any) => { storyUpdates.push(data); return {}; },
    },
    task: {
      findMany: async ({ where }: any) => (where?.status ? [] : (opts.existingTitles || []).map((t) => ({ title: t }))),
      update: async ({ where, data }: any) => { const t = createdTasks.find((x) => x.id === where.id); if (t) Object.assign(t, data); return t; },
    },
    contact: { findMany: async () => [{ id: 'c-mad', name: 'Madhuri', aliases: '[]' }, { id: 'c-sri', name: 'Srikar', aliases: '[]' }] },
    // BEA-1161: chase times now come from the owner's settings, not a constant in the service.
    setting: { findUnique: async () => null },
    dayEvent: {
      deleteMany: async () => ({}),
      create: async ({ data }: any) => { dayEvents.push(data); return data; },
    },
    mindFinding: { create: async ({ data }: any) => { findings.push(data); return { id: 'f1', ...data }; } },
  };
  const asks: string[] = [];
  const llm: any = { completeWith: async (_m: any, prompt: string) => { asks.push(prompt); return llmReply; } };
  // `asks.length` IS the count of paid calls — the thing BEA-1164 exists to keep at zero.
  const tasks: any = {
    whereForDay: async () => ({}),
    create: async (d: any) => { const t = { id: `t${++seq}`, ...d }; createdTasks.push(t); return t; },
    createDoneTask: async (title: string, category: any, day: string) => { const t = { id: `d${++seq}`, title, category, day }; doneTasks.push(t); return t; },
  };
  const reminders: any = { create: async (d: any) => { chases.push(d); return d; } };
  const daily: any = { storyModel: async () => ({ provider: 'openrouter', model: 'x' }) };
  // A DISTINCT prompt per key, as the real service has — otherwise the two halves send identical
  // asks and a test about "the retry differs" passes for the wrong reason. (BEA-1166)
  const prompts: any = { get: async (k: string) => `PROMPT[${k}] for {{day}}` };
  const svc = new StoryMiningService(prisma, llm, tasks, reminders, daily, prompts);
  return { svc, createdTasks, doneTasks, chases, dayEvents, findings, storyUpdates, asks };
}

describe('mine — proposes everything, creates nothing (BEA-1051)', () => {
  it('returns every section from a rich diary', async () => {
    const { svc, createdTasks, doneTasks } = make(RICH);
    const m = await svc.mine('2026-07-22');
    expect(m.done.map((d) => d.title)).toEqual(['Fixed the QC checklist']);
    expect(m.todos[0]).toMatchObject({ title: 'Order solder paste', priority: 'high' });
    expect(m.myReminders[0]).toEqual({ title: 'Renew the insurance', date: '2026-07-30' });
    expect(m.emotions).toMatchObject({ energy: 70, worry: 40 });
    expect(m.events).toHaveLength(2);
    expect(m.lessons).toHaveLength(1);
    expect(createdTasks).toHaveLength(0); // nothing saved by mining
    expect(doneTasks).toHaveLength(0);
  });

  it('links a delegation ONLY on an exact contact match — never a guess', async () => {
    const { svc } = make(RICH);
    const m = await svc.mine('2026-07-22');
    const mad = m.delegations.find((d) => d.contactName === 'Madhuri')!;
    const stranger = m.delegations.find((d) => d.contactName === 'Someone New')!;
    expect(mad.contactId).toBe('c-mad');
    expect(stranger.contactId).toBeNull();
    expect(m.promises[0]).toMatchObject({ to: 'Srikar', contactId: 'c-sri', date: '2026-07-25' });
  });

  it('does not re-propose work that is already logged', async () => {
    const { svc } = make(RICH, { existingTitles: ['Fixed the QC checklist for the line'] });
    const m = await svc.mine('2026-07-22');
    expect(m.done).toHaveLength(0); // overlaps the logged task
  });

  it('an unusable model reply is flagged failed=true — never dressed up as a tidy day', async () => {
    const { svc } = make('sorry, plain prose');
    const m = await svc.mine('2026-07-22');
    expect(m.hasStory).toBe(true);
    expect(m.failed).toBe(true); // the wizard shows an honest Retry, not "nothing new found"
    expect(m.done).toEqual([]);
    expect(m.delegations).toEqual([]);
  });

  it('a good parse carries no failed flag', async () => {
    const { svc } = make(RICH);
    expect((await svc.mine('2026-07-22')).failed).toBeUndefined();
  });
});

describe('apply — exactly what was ticked, through the real doors (BEA-1051)', () => {
  it('creates the delegation as an owned task WITH a chase, and an unlinked one WITHOUT', async () => {
    const { svc, createdTasks, chases } = make(RICH);
    await svc.apply('2026-07-22', {
      delegations: [
        { contactName: 'Madhuri', contactId: 'c-mad', title: 'Send the Focus ERP report', chase: true },
        { contactName: 'Someone New', contactId: null, title: 'Paint the stall banners', chase: true },
      ],
    });
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[0]).toMatchObject({ ownerContactId: 'c-mad', party: 'Madhuri' });
    expect(createdTasks[1].ownerContactId).toBeUndefined(); // unlinked person: display text only
    expect(chases).toHaveLength(1); // no contact, no chase — never message a guessed number
    expect(chases[0]).toMatchObject({ contactId: 'c-mad', repeat: 'daily' });
  });

  it('a promise becomes a high-priority task carrying its promised date', async () => {
    const { svc, createdTasks } = make(RICH);
    await svc.apply('2026-07-22', { promises: [{ to: 'Srikar', contactId: 'c-sri', what: 'Pay the pending invoice', date: '2026-07-25' }] });
    expect(createdTasks[0]).toMatchObject({ title: 'Pay the pending invoice', priority: 'high', promisedFor: '2026-07-25' });
  });

  it('emotions land on the story; events replace prior mined ones; lessons reach the Lab', async () => {
    const { svc, storyUpdates, dayEvents, findings } = make(RICH);
    const counts = await svc.apply('2026-07-22', {
      emotions: { lifted: ['x'], drained: [], energy: 70, worry: 40, feeling: 'ok' },
      events: [{ at: 'morning', title: 'Factory' }],
      lessons: ['Late nights eat mornings'],
    });
    expect(counts).toMatchObject({ emotions: 1, events: 1, lessons: 1 });
    expect(JSON.parse(storyUpdates[0].emotions).energy).toBe(70);
    expect(dayEvents[0]).toMatchObject({ day: '2026-07-22', title: 'Factory', source: 'story' });
    expect(findings[0]).toMatchObject({ statement: 'Late nights eat mornings', status: 'proposed', firstSeenDay: '2026-07-22' });
  });

  it('backfillFeelings writes ONLY emotions + events for already-told days — no tasks (BEA-1058)', async () => {
    const { svc, createdTasks, storyUpdates, dayEvents } = make(RICH);
    // one story with no emotions yet
    (svc as any).prisma.story.findMany = async () => [{ id: 's1', day: '2026-07-22', rawText: 'A long real diary about the whole day at the factory and beyond, lots to mine.', emotions: null }];
    const r = await svc.backfillFeelings(7);
    expect(r.filled).toBe(1);
    expect(storyUpdates.some((u: any) => u.emotions)).toBe(true); // emotions written
    expect(dayEvents.length).toBeGreaterThan(0); // life events written
    expect(createdTasks).toHaveLength(0); // NOTHING created — visible parts only
  });

  it('applying an empty pick creates nothing', async () => {
    const { svc, createdTasks, doneTasks, chases } = make(RICH);
    const counts = await svc.apply('2026-07-22', {});
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(createdTasks.length + doneTasks.length + chases.length).toBe(0);
  });
});

/**
 * BEA-1163. On 28 July this failed three times: the reply hit the 2500-token ceiling, was cut off
 * mid-JSON, and the whole thing was discarded — then the retry sent the identical request and
 * failed identically, which is why every failure in the log is a pair.
 */
describe('a long story no longer loses the day (BEA-1163)', () => {
  const CUT_OFF = '{"done":[{"title":"Called the CA"},{"title":"Sent the sheet"}],"todos":[{"title":"Chase the vend';

  it('keeps what was read when the reply is cut off, instead of failing', async () => {
    const h = make(CUT_OFF);
    const r: any = await h.svc.mine('2026-07-28');
    expect(r.failed).toBeFalsy();
    expect(r.done.map((d: any) => d.title)).toEqual(['Called the CA', 'Sent the sheet']);
  });

  it('says the day was cut short rather than looking tidy', async () => {
    const h = make(CUT_OFF);
    const r: any = await h.svc.mine('2026-07-28');
    expect(r.partial).toBe(true);
  });

  it('a whole reply is not flagged as partial', async () => {
    const h = make('{"done":[{"title":"Called the CA"}],"todos":[]}');
    const r: any = await h.svc.mine('2026-07-28');
    expect(r.partial).toBeFalsy();
    expect(r.done).toHaveLength(1);
  });

  it('the retry asks for something DIFFERENT from the first attempt', async () => {
    const h = make('not json at all');
    await h.svc.mine('2026-07-28');
    // Both halves fail and both retry: 2 halves x 2 attempts.
    expect(h.asks).toHaveLength(4);
    const retries = h.asks.filter((a) => a.includes('keep it SHORT'));
    expect(retries).toHaveLength(2); // one retry per half
    // and each retry differs from the first go at that same half
    expect(new Set(h.asks).size).toBe(4);
  });

  it('still fails honestly when nothing usable came back at all', async () => {
    const h = make('sorry, I cannot');
    const r: any = await h.svc.mine('2026-07-28');
    expect(r.failed).toBe(true);
  });
});

/**
 * BEA-1164. The reading is stored against the story it came from, so reopening step 2 costs him
 * nothing. His words: *"after story in the popup in the step 2 accidentally if something wrong
 * happens it has to save the information it should not run api calls repeatedly."*
 */
describe('the day\'s reading is paid for once (BEA-1164)', () => {
  const RAW = 'A long real diary entry about the whole day at the factory and beyond.';
  const READING = JSON.stringify({ done: [{ title: 'Fixed the QC checklist', category: 'Factory' }], todos: [], delegations: [], myReminders: [], promises: [], emotions: null, events: [], lessons: [] });
  const { storyFingerprint } = require('./mine-cache');

  it('stores the reading it just paid for', async () => {
    const h = make(RICH);
    await h.svc.mine('2026-07-22');
    const saved = h.storyUpdates.find((u: any) => u.mined);
    expect(saved).toBeTruthy();
    expect(JSON.parse(saved.mined).done[0].title).toBe('Fixed the QC checklist');
    expect(saved.minedHash).toBe(storyFingerprint(RAW));
  });

  it('serves the stored reading with NO call at all', async () => {
    const h = make(RICH, { mined: READING, minedHash: storyFingerprint(RAW) });
    const m: any = await h.svc.mine('2026-07-22');
    expect(h.asks).toHaveLength(0); // nothing was asked, nothing was charged
    expect(m.cached).toBe(true);
    expect(m.stale).toBe(false);
    expect(m.done[0].title).toBe('Fixed the QC checklist');
  });

  it('an edited story still costs nothing — it comes back flagged, not re-run', async () => {
    const h = make(RICH, { mined: READING, minedHash: storyFingerprint('something he wrote earlier') });
    const m: any = await h.svc.mine('2026-07-22');
    expect(h.asks).toHaveLength(0);
    expect(m.stale).toBe(true);
  });

  it('reads afresh only when HE presses the button', async () => {
    const h = make(RICH, { mined: READING, minedHash: storyFingerprint(RAW) });
    const m: any = await h.svc.mine('2026-07-22', { force: true });
    expect(h.asks).toHaveLength(CALLS_PER_READ);
    expect(m.cached).toBeFalsy();
  });

  it('a failed reading is never served back — he is not trapped on a bad read', async () => {
    const h = make(RICH, { mined: JSON.stringify({ failed: true }), minedHash: storyFingerprint(RAW) });
    const m: any = await h.svc.mine('2026-07-22');
    expect(h.asks).toHaveLength(CALLS_PER_READ); // it reads for real
    expect(m.failed).toBeFalsy();
  });
});

/** BEA-1164 review finding: two opens of the same day must not both pay for the read. */
describe('one read per day, however many tabs are open (BEA-1164)', () => {
  /**
   * Hold the model call open until the test says go. The service runs several database awaits
   * before it ever reaches the model, so the test must WAIT for the call rather than assume it has
   * already happened — releasing too early is how this test first hung for sixty seconds.
   */
  function gate(h: ReturnType<typeof make>) {
    const releases: ((v: string) => void)[] = [];
    (h.svc as any).llm.completeWith = (_m: any, prompt: string) => {
      h.asks.push(prompt);
      return new Promise<string>((res) => releases.push(res));
    };
    return {
      untilCalled: async (n: number) => {
        for (let i = 0; i < 500 && releases.length < n; i++) await new Promise((r) => setImmediate(r));
        expect(releases.length).toBe(n); // fail loudly here rather than time out later
      },
      releaseAll: () => releases.forEach((r) => r(RICH)),
    };
  }

  it('two callers at once share ONE call', async () => {
    const h = make(RICH);
    const g = gate(h);
    const a = h.svc.mine('2026-07-22');
    const b = h.svc.mine('2026-07-22');
    await g.untilCalled(CALLS_PER_READ);
    g.releaseAll();
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.asks).toHaveLength(CALLS_PER_READ); // ONE read between them, not one each
    expect(ra.done[0].title).toBe(rb.done[0].title);
  });

  it('a finished read does not block the next one', async () => {
    const h = make(RICH);
    await h.svc.mine('2026-07-22');
    await h.svc.mine('2026-07-22', { force: true });
    expect(h.asks).toHaveLength(2 * CALLS_PER_READ); // the guard is per in-flight read, not a permanent lock
  });

  it('his "Read it again" is never swallowed by a cached read already running', async () => {
    const h = make(RICH);
    const g = gate(h);
    const cached = h.svc.mine('2026-07-22');
    const forced = h.svc.mine('2026-07-22', { force: true });
    await g.untilCalled(2 * CALLS_PER_READ);
    g.releaseAll();
    await Promise.all([cached, forced]);
    expect(h.asks).toHaveLength(2 * CALLS_PER_READ); // a forced re-read is a DIFFERENT request; it must not be deduped away
  });
});

/**
 * BEA-1166. One call doing eight jobs took 20-30 seconds — the wait he said was "bothering me a
 * lot". Two calls at the same time halve it, and make a bad reply cost half a day instead of all
 * of it.
 */
describe('the read runs as two halves, side by side (BEA-1166)', () => {
  const WORK = JSON.stringify({ done: [{ title: 'Fixed the QC checklist' }], todos: [], delegations: [], myReminders: [], promises: [] });
  const DAY = JSON.stringify({ emotions: { lifted: ['x'], drained: [], energy: 70, worry: 20, feeling: 'Steady.' }, events: [{ at: 'morning', title: 'Factory' }], lessons: ['Late nights eat mornings'] });

  /** Answer each half differently, so a test can fail one and keep the other. */
  function halves(h: ReturnType<typeof make>, work: string | null, day: string | null) {
    (h.svc as any).llm.completeWith = async (_m: any, prompt: string) => {
      h.asks.push(prompt);
      return prompt.includes('storyMineWork') ? work : day;
    };
  }

  it('both halves are asked, and the answers are merged into one reading', async () => {
    const h = make(null);
    halves(h, WORK, DAY);
    const r: any = await h.svc.mine('2026-07-22');
    expect(h.asks.filter((a) => a.includes('storyMineWork'))).toHaveLength(1);
    expect(h.asks.filter((a) => a.includes('storyMineDay'))).toHaveLength(1);
    expect(r.done[0].title).toBe('Fixed the QC checklist');
    expect(r.events[0].title).toBe('Factory');
    expect(r.emotions.energy).toBe(70);
    expect(r.failed).toBeFalsy();
    expect(r.missing).toBeNull();
  });

  it('they run AT THE SAME TIME — the second does not wait for the first', async () => {
    const h = make(null);
    let live = 0;
    let bothAtOnce = false;
    (h.svc as any).llm.completeWith = async (_m: any, prompt: string) => {
      h.asks.push(prompt);
      live++;
      if (live > 1) bothAtOnce = true;
      await new Promise((r) => setImmediate(r));
      live--;
      return prompt.includes('storyMineWork') ? WORK : DAY;
    };
    await h.svc.mine('2026-07-22');
    expect(bothAtOnce).toBe(true); // the whole point: the wait is the slower half, not the sum
  });

  it('the day half is NOT sent the task lists it has no use for', async () => {
    const h = make(null);
    halves(h, WORK, DAY);
    await h.svc.mine('2026-07-22');
    const workAsk = h.asks.find((a) => a.includes('storyMineWork'))!;
    const dayAsk = h.asks.find((a) => a.includes('storyMineDay'))!;
    expect(workAsk).toContain('Already logged:'); // it needs these to avoid re-proposing known work
    expect(workAsk).toContain('Known contact names');
    expect(dayAsk).not.toContain('Already logged:'); // feelings and a timeline need none of it
    expect(dayAsk).not.toContain('Known contact names');
    expect(dayAsk).toContain('DIARY:'); // but it still gets his actual day
  });

  it('losing the DAY half still gives him every task, and says what is missing', async () => {
    const h = make(null);
    halves(h, WORK, 'sorry, not json');
    const r: any = await h.svc.mine('2026-07-22');
    expect(r.failed).toBeFalsy(); // the old single call would have lost the lot
    expect(r.done[0].title).toBe('Fixed the QC checklist');
    expect(r.events).toEqual([]);
    expect(r.missing).toBe('day');
  });

  it('losing the WORK half still gives him how the day felt, and says what is missing', async () => {
    const h = make(null);
    halves(h, 'sorry, not json', DAY);
    const r: any = await h.svc.mine('2026-07-22');
    expect(r.failed).toBeFalsy();
    expect(r.emotions.energy).toBe(70);
    expect(r.done).toEqual([]);
    expect(r.missing).toBe('work');
  });

  it('a half-missing reading survives the cache — he is told the same thing next time', async () => {
    const { storyFingerprint } = require('./mine-cache');
    const h = make(null);
    halves(h, WORK, 'sorry, not json');
    const first: any = await h.svc.mine('2026-07-22');
    expect(first.missing).toBe('day');
    // Reopen: the stored reading must still say which half was lost, or the wizard quietly claims
    // a whole day it never got. (BEA-1166 on top of BEA-1164)
    const stored = h.storyUpdates.find((u: any) => u.mined);
    const h2 = make(null, { mined: stored.mined, minedHash: stored.minedHash });
    const again: any = await h2.svc.mine('2026-07-22');
    expect(h2.asks).toHaveLength(0);
    expect(again.missing).toBe('day');
    expect(again.done[0].title).toBe('Fixed the QC checklist');
  });

  it('only a total blank is an honest failure', async () => {
    const h = make(null);
    halves(h, 'nope', 'nope');
    const r: any = await h.svc.mine('2026-07-22');
    expect(r.failed).toBe(true);
  });

  it('a half that only half-arrived is still flagged partial', async () => {
    const h = make(null);
    halves(h, '{"done":[{"title":"Called the CA"},{"title":"Sent the she', DAY);
    const r: any = await h.svc.mine('2026-07-22');
    expect(r.partial).toBe(true);
    expect(r.done.map((d: any) => d.title)).toEqual(['Called the CA']);
  });
});
