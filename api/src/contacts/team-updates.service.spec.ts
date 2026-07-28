import { TeamUpdatesService } from './team-updates.service';

/**
 * BEA-1159. The loop in the owner's words: "If they need my help, it will land in the review
 * section. I will message them in the review section, and if the help is done, I will close it."
 *
 * The rule that broke before: a later message must never erase that someone asked for help. The old
 * `needsOwner` flag was cleared by the next reply the agent could handle, so a "Kk sir" wiped it.
 */
function make(opts: { sendFails?: boolean; number?: string | null } = {}) {
  const rows: any[] = [];
  const sent: any[] = [];
  const thread: any[] = [];
  let seq = 0;
  const prisma: any = {
    teamUpdate: {
      findFirst: async ({ where }: any) => rows.find((r) => r.contactId === where.contactId && r.text === where.text) || null,
      findUnique: async ({ where }: any) => { const r = rows.find((x) => x.id === where.id); return r ? { ...r, contact: { id: 'c1', name: 'Radha', whatsappNumber: opts.number === undefined ? '919000000000' : opts.number } } : null; },
      // Honour orderBy the way real prisma does — forContact reads desc then reverses, so a double
      // that ignores it silently flips the whole thread.
      findMany: async ({ where, orderBy }: any = {}) =>
        [...rows]
          .sort((a, b) => (orderBy?.at === 'desc' ? +new Date(b.at) - +new Date(a.at) : +new Date(a.at) - +new Date(b.at)))
          .filter((r) => (where?.needsYou === undefined || r.needsYou === where.needsYou))
          .filter((r) => (where?.closedAt === undefined || (where.closedAt === null ? !r.closedAt : true)))
          .filter((r) => (where?.contactId === undefined || r.contactId === where.contactId))
          .map((r) => ({ ...r, contact: { id: 'c1', name: 'Radha', whatsappNumber: opts.number === undefined ? '919000000000' : opts.number }, task: null })),
      create: async ({ data }: any) => { const r = { id: `u${++seq}`, closedAt: null, ...data }; rows.push(r); return r; },
      update: async ({ where, data }: any) => { const r = rows.find((x) => x.id === where.id); Object.assign(r, data); return r; },
    },
    reminder: { count: async () => 0 },
    reminderMessage: { create: async ({ data }: any) => { thread.push(data); return data; } },
    taskClaim: { findMany: async () => [], findFirst: async () => null },
    // BEA-1159: a "done" update looks up their other open jobs so it can split by task.
    task: { findMany: async () => [], findUnique: async () => null, count: async () => 0 },
    taskStatusDay: { findMany: async () => [] },
  };
  const postbox: any = {
    isConfigured: () => true,
    sendText: async (to: string, body: string) => { sent.push({ to, body }); return opts.sendFails ? { status: 'failed', error: 'window shut' } : { status: 'sent', wamid: 'w1' }; },
  };
  return { svc: new TeamUpdatesService(prisma, postbox), rows, sent, thread };
}

const RADHA = "1. We didn't receive sense PCB for 4M - 4 Switch 1Socket\n2. ESP Add on PCB for magnetic touch was pending";

describe('the review loop (BEA-1159)', () => {
  it("Radha's blockers open a review item", async () => {
    const { svc } = make();
    await svc.record({ contactId: 'c1', text: RADHA, channel: 'whatsapp', isReport: true });
    const inbox: any = await svc.inbox();
    expect(inbox.count).toBe(1);
    expect(inbox.items[0].label).toContain('problem');
    expect(inbox.items[0].text).toContain('sense PCB');
  });

  it('a "Kk sir" afterwards does NOT erase it — that is the bug this replaces', async () => {
    const { svc } = make();
    await svc.record({ contactId: 'c1', text: RADHA, channel: 'whatsapp', isReport: true });
    await svc.record({ contactId: 'c1', text: 'Kk sir', channel: 'whatsapp', isReport: true });
    expect((await svc.inbox()).count).toBe(1);
  });

  it('replying sends on WhatsApp, lands in their thread, and leaves it OPEN', async () => {
    const { svc, sent, thread } = make();
    await svc.record({ contactId: 'c1', text: RADHA, channel: 'whatsapp', isReport: true });
    const id = (await svc.inbox()).items[0].id;
    const r: any = await svc.reply(id, "I'll chase the PCB supplier today.");
    expect(r.ok).toBe(true);
    expect(sent[0].body).toContain('PCB supplier');
    expect(thread[0]).toMatchObject({ direction: 'out' });
    expect((await svc.inbox()).count).toBe(1); // answering is not solving
  });

  it('only closing removes it', async () => {
    const { svc } = make();
    await svc.record({ contactId: 'c1', text: RADHA, channel: 'whatsapp', isReport: true });
    const id = (await svc.inbox()).items[0].id;
    await svc.close(id);
    expect((await svc.inbox()).count).toBe(0);
  });

  it('a closed item can be re-opened when he closed it by mistake', async () => {
    const { svc } = make();
    await svc.record({ contactId: 'c1', text: RADHA, channel: 'whatsapp', isReport: true });
    const id = (await svc.inbox()).items[0].id;
    await svc.close(id);
    await svc.reopen(id);
    expect((await svc.inbox()).count).toBe(1);
  });

  it('a failed send says so plainly and never pretends it went', async () => {
    const { svc, thread } = make({ sendFails: true });
    await svc.record({ contactId: 'c1', text: RADHA, channel: 'whatsapp', isReport: true });
    const id = (await svc.inbox()).items[0].id;
    const r: any = await svc.reply(id, 'hello');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('24-hour');
    expect(thread).toHaveLength(0);
  });

  it('someone with no number is told so, rather than silently failing', async () => {
    const { svc } = make({ number: null });
    await svc.record({ contactId: 'c1', text: RADHA, channel: 'whatsapp', isReport: true });
    const id = (await svc.inbox()).items[0].id;
    const r: any = await svc.reply(id, 'hello');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no WhatsApp number');
  });

  it('a routine report never reaches the inbox', async () => {
    const { svc } = make();
    await svc.record({ contactId: 'c1', text: 'In Production: 2000 magnetic touch PCB completed.', channel: 'whatsapp', isReport: true });
    expect((await svc.inbox()).count).toBe(0);
  });

  it('the same message twice is recorded once', async () => {
    const { svc, rows } = make();
    const at = new Date();
    await svc.record({ contactId: 'c1', text: RADHA, channel: 'whatsapp', at, isReport: true });
    await svc.record({ contactId: 'c1', text: RADHA, channel: 'link', at, isReport: true });
    expect(rows).toHaveLength(1);
  });

  it('a link note is recorded with its channel, so the source is never lost', async () => {
    const { svc } = make();
    await svc.record({ contactId: 'c1', text: 'We are short of 200 units', channel: 'link' });
    expect((await svc.inbox()).items[0].channel).toBe('link');
  });
});

/**
 * BEA-1159 steps 3 and 4. Swathi wrote three messages on her link in one morning and had sixty
 * WhatsApp messages on her page — and none of the three appeared there. One thread fixes that.
 */
describe("one person's whole story, both channels (BEA-1159)", () => {
  it('returns their updates oldest-first, so it reads like a conversation', async () => {
    const { svc } = make();
    const t = (m: number) => new Date(Date.UTC(2026, 6, 28, 9, m));
    await svc.record({ contactId: 'c1', text: 'Yes, Everyone is using HRMS', channel: 'link', at: t(12) });
    await svc.record({ contactId: 'c1', text: 'We are short of 200 units', channel: 'whatsapp', at: t(40) });
    const rows: any[] = await svc.forContact('c1');
    expect(rows.map((r) => r.channel)).toEqual(['link', 'whatsapp']);
    expect(rows[1].needsYou).toBe(true);
  });

  it('a message with no task attached is still recorded — they can just talk', async () => {
    const { svc, rows } = make();
    const r = await svc.record({ contactId: 'c1', text: 'The KIOT thing slipped, here is why', channel: 'link' });
    expect(r).toBeTruthy();
    expect(rows[0].taskId).toBeNull();
  });

  it('keeps a closed one in the story, marked closed, rather than deleting it', async () => {
    const { svc } = make();
    await svc.record({ contactId: 'c1', text: 'We are short of 200 units', channel: 'link' });
    const id = (await svc.inbox()).items[0].id;
    await svc.close(id);
    const rows: any[] = await svc.forContact('c1');
    expect(rows).toHaveLength(1);
    expect(rows[0].closedAt).toBeTruthy();
  });
});

/**
 * BEA-1159. The owner asked where the yes/no was, and he was right that it wasn't there — the
 * screen shipped with only "Sorted, close it", which decided nothing. A pending claim keeps the
 * chase quiet, so an undecided claim left the task open forever with nobody chasing it.
 *
 * His rule: *"If I say it's done, that means you don't need to chase them again."* And the other
 * half — saying it isn't finished has to put the chase back on.
 */
describe('yes it is done / no it is not (BEA-1159)', () => {
  function withClaim(claim: any | null, contactClaims: any[] = claim ? [claim] : []) {
    const { svc, rows } = make();
    // Deciding really does take the claim out of "pending", so the double has to as well —
    // otherwise the orphan sweep would keep re-adding a claim that has been answered.
    const state = { decided: false };
    (svc as any).prisma.taskClaim = {
      findFirst: async () => (state.decided ? null : claim),
      findMany: async () => (state.decided ? [] : contactClaims),
    };
    (svc as any).prisma.task = { findMany: async () => [], count: async () => 0, findUnique: async () => ({ id: 't1', title: 'Send the geyser update', status: 'open' }) };
    return { svc, rows, state };
  }

  it('offers the decision when they claimed a task finished', async () => {
    const { svc } = withClaim({ id: 'cl1' });
    await svc.record({ contactId: 'c1', text: 'It is completed', channel: 'whatsapp', taskId: 't1' });
    const inbox: any = await svc.inbox();
    expect(inbox.items[0].claimId).toBe('cl1');
  });

  it('a problem is not a yes/no — there is nothing to confirm', async () => {
    const { svc } = withClaim(null);
    await svc.record({ contactId: 'c1', text: 'We are short of 200 units', channel: 'whatsapp', taskId: 't1' });
    expect((await svc.inbox()).items[0].claimId).toBeNull();
  });

  it('"yes" decides the claim and takes it out of his inbox', async () => {
    const { svc, state } = withClaim({ id: 'cl1' });
    await svc.record({ contactId: 'c1', text: 'It is completed', channel: 'whatsapp', taskId: 't1' });
    const id = (await svc.inbox()).items[0].id;
    const calls: any[] = [];
    const r: any = await svc.decide(id, true, async (claimId, ok) => { calls.push({ claimId, ok }); state.decided = true; return { ok: true }; });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ claimId: 'cl1', ok: true }]);
    expect((await svc.inbox()).count).toBe(0);
  });

  it('"no" rejects the claim — which is what puts the chase back on', async () => {
    const { svc } = withClaim({ id: 'cl1' });
    await svc.record({ contactId: 'c1', text: 'It is completed', channel: 'whatsapp', taskId: 't1' });
    const id = (await svc.inbox()).items[0].id;
    const calls: any[] = [];
    await svc.decide(id, false, async (claimId, ok) => { calls.push({ claimId, ok }); return { ok: true }; });
    expect(calls).toEqual([{ claimId: 'cl1', ok: false }]);
  });

  it('an already-decided claim says so rather than deciding twice', async () => {
    const { svc } = withClaim(null);
    await svc.record({ contactId: 'c1', text: 'It is completed', channel: 'whatsapp', taskId: 't1' });
    const id = (await svc.inbox()).items[0].id;
    let called = false;
    const r: any = await svc.decide(id, true, async () => { called = true; return { ok: true }; });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});

/**
 * Found live: the backfill could not know which task a WhatsApp reply was about, so only 1 of the
 * owner's open items had a task — and with no task there was no claim and no yes/no. It falls back
 * to the contact's pending claim, but only when there is exactly one: with two open, guessing would
 * mark the wrong job finished.
 */
describe('finding the claim when the message names no task', () => {
  function svcWith(contactClaims: any[]) {
    const { svc } = make();
    (svc as any).prisma.taskClaim = { findFirst: async () => null, findMany: async () => contactClaims };
    (svc as any).prisma.task = { findMany: async () => [], count: async () => 0, findUnique: async () => ({ id: 't9', title: 'Send the geyser update', status: 'open' }) };
    return svc;
  }

  it('uses their one pending claim, and says which task it is', async () => {
    const svc = svcWith([{ id: 'cl9', taskId: 't9' }]);
    await svc.record({ contactId: 'c1', text: 'It is completed', channel: 'whatsapp' });
    const item: any = (await svc.inbox()).items[0];
    expect(item.claimId).toBe('cl9');
    expect(item.task.title).toBe('Send the geyser update');
  });

  it('refuses to guess when they have two open — the wrong one would be marked done', async () => {
    const svc = svcWith([{ id: 'cl1', taskId: 't1' }, { id: 'cl2', taskId: 't2' }]);
    await svc.record({ contactId: 'c1', text: 'It is completed', channel: 'whatsapp' });
    expect((await svc.inbox()).items[0].claimId).toBeNull();
  });

  it('and deciding is refused too, not just hidden', async () => {
    const svc = svcWith([{ id: 'cl1', taskId: 't1' }, { id: 'cl2', taskId: 't2' }]);
    await svc.record({ contactId: 'c1', text: 'It is completed', channel: 'whatsapp' });
    const id = (await svc.inbox()).items[0].id;
    let called = false;
    const r: any = await svc.decide(id, true, async () => { called = true; return { ok: true }; });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});

/**
 * Found live, an hour after shipping: the owner closed an item without deciding, and its claim
 * stayed pending. A pending claim keeps the chase quiet, so Deepthi sat un-chased with no way for
 * him to rule on it. A claim must always be answerable, whatever happened to the message.
 */
describe('a pending claim can never be orphaned (BEA-1159)', () => {
  function svcWithOrphan() {
    const { svc } = make();
    const claim = { id: 'cl7', taskId: 't7', quote: 'Task 1 all finished', createdAt: new Date(Date.now() - 2 * 86400000), source: 'whatsapp', contact: { id: 'c1', name: 'Deepthi', whatsappNumber: '9190' }, task: { id: 't7', title: 'Send the geyser update', status: 'open' } };
    (svc as any).prisma.taskClaim = {
      findFirst: async ({ where }: any) => (where?.id === 'cl7' && where?.status === 'pending' ? claim : null),
      findMany: async () => [claim],
    };
    (svc as any).prisma.task = { findMany: async () => [], count: async () => 0, findUnique: async () => claim.task };
    return svc;
  }

  it('shows the claim even when no message is open for it', async () => {
    const svc = svcWithOrphan();
    const inbox: any = await svc.inbox();
    const item = inbox.items.find((i: any) => i.claimId === 'cl7');
    expect(item).toBeTruthy();
    expect(item.task.title).toBe('Send the geyser update');
    expect(item.openDays).toBe(2);
  });

  it('and it can be decided from there', async () => {
    const svc = svcWithOrphan();
    const id = (await svc.inbox()).items.find((i: any) => i.claimId === 'cl7').id;
    const calls: any[] = [];
    const r: any = await svc.decide(id, false, async (claimId, ok) => { calls.push({ claimId, ok }); return { ok: true }; });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ claimId: 'cl7', ok: false }]); // "no" — the chase resumes
  });

  it('a claim already decided elsewhere says so rather than deciding twice', async () => {
    const svc = svcWithOrphan();
    (svc as any).prisma.taskClaim.findFirst = async () => null;
    const r: any = await svc.decide('claim:cl7', true, async () => ({ ok: true }));
    expect(r.ok).toBe(false);
  });
});

/**
 * BEA-1159. The owner: *"Split by task. They might be only doing one task. You have to split a task."*
 *
 * Deepthi has two open jobs — the geyser components and the PCB order — and one message covering
 * both, with only one claim ever raised. A single yes/no over the whole message means ruling on one
 * and never seeing the other, so the PCB job would quietly stop being chased.
 */
describe('one row per job when they say something is done (BEA-1159)', () => {
  const TASKS = [
    { id: 'geyser', title: 'Send status update on the geyser components order', status: 'open' },
    { id: 'pcb', title: 'Send status update on the PCB order', status: 'open' },
  ];

  function svcWithTasks(tasks = TASKS, claimFor: string | null = 'geyser') {
    const { svc, rows } = make();
    (svc as any).prisma.task = { findMany: async () => tasks, count: async ({ where }: any) => tasks.filter((t) => !(where?.NOT?.id?.in || []).includes(t.id)).length, findUnique: async ({ where }: any) => tasks.find((t) => t.id === where.id) || null };
    (svc as any).prisma.taskClaim = {
      findFirst: async ({ where }: any) => (where?.taskId && where.taskId === claimFor ? { id: `cl-${claimFor}`, taskId: claimFor } : null),
      findMany: async () => [],
    };
    return { svc, rows };
  }

  it('splits one message into one row per job', async () => {
    const { svc } = svcWithTasks();
    await svc.record({ contactId: 'c1', text: 'All geyser and PCB components received, done', channel: 'whatsapp' });
    const inbox: any = await svc.inbox();
    expect(inbox.items).toHaveLength(2);
    expect(inbox.items.map((i: any) => i.task.id).sort()).toEqual(['geyser', 'pcb']);
    expect(inbox.items.every((i: any) => i.perTask)).toBe(true);
  });

  it('the one with a claim decides that claim; the one without is marked done directly', async () => {
    const { svc } = svcWithTasks();
    await svc.record({ contactId: 'c1', text: 'All geyser and PCB components received, done', channel: 'whatsapp' });
    const inbox: any = await svc.inbox();
    const geyser = inbox.items.find((i: any) => i.task.id === 'geyser');
    const pcb = inbox.items.find((i: any) => i.task.id === 'pcb');
    expect(geyser.claimId).toBe('cl-geyser');
    expect(pcb.claimId).toBeNull();

    const decided: any[] = [];
    const doneDirect: any[] = [];
    await svc.decide(geyser.id, true, async (c, ok) => { decided.push({ c, ok }); return { ok: true }; }, async (t, d) => { doneDirect.push({ t, d }); });
    await svc.decide(pcb.id, true, async (c, ok) => { decided.push({ c, ok }); return { ok: true }; }, async (t, d) => { doneDirect.push({ t, d }); });
    expect(decided).toEqual([{ c: 'cl-geyser', ok: true }]);
    expect(doneDirect).toEqual([{ t: 'pcb', d: true }]);
  });

  it('saying yes to one does NOT take the other off his list', async () => {
    const { svc } = svcWithTasks();
    await svc.record({ contactId: 'c1', text: 'All geyser and PCB components received, done', channel: 'whatsapp' });
    const geyser = (await svc.inbox()).items.find((i: any) => i.task.id === 'geyser');
    await svc.decide(geyser.id, true, async () => ({ ok: true }), async () => undefined);
    const after: any = await svc.inbox();
    expect(after.items.map((i: any) => i.task.id)).toEqual(['pcb']);
  });

  it('a decided row does not come back', async () => {
    const { svc } = svcWithTasks();
    await svc.record({ contactId: 'c1', text: 'All geyser and PCB components received, done', channel: 'whatsapp' });
    const pcb = (await svc.inbox()).items.find((i: any) => i.task.id === 'pcb');
    await svc.decide(pcb.id, false, async () => ({ ok: true }), async () => undefined);
    const after: any = await svc.inbox();
    expect(after.items.map((i: any) => i.task.id)).not.toContain('pcb');
  });

  it('someone with only one open job is not split — there is nothing to split', async () => {
    const { svc } = svcWithTasks([TASKS[0]]);
    await svc.record({ contactId: 'c1', text: 'It is completed', channel: 'whatsapp' });
    const inbox: any = await svc.inbox();
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].perTask).toBeUndefined();
  });

  it('a problem is never split — it is one thing to read, not a decision per job', async () => {
    const { svc } = svcWithTasks();
    await svc.record({ contactId: 'c1', text: 'We are short of 200 units', channel: 'whatsapp' });
    const inbox: any = await svc.inbox();
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].perTask).toBeUndefined();
  });
});

/**
 * Srikar has four open jobs. One "done" from him must not put four rows in front of the owner,
 * three of them about work nobody mentioned — an inbox with noise in it stops being read.
 */
describe('split only into the jobs they named', () => {
  const FOUR = [
    { id: 'zigbee', title: 'Share a clear update on ZigBee protocol testing status', status: 'open' },
    { id: 'curtains', title: 'Share a clear update on Wi-Fi curtains and blinds testing', status: 'open' },
    { id: 'pins', title: 'Share a clear update on the smart plug socket pins plan', status: 'open' },
    { id: 'collections', title: "Share next month's payment collection details", status: 'open' },
  ];

  function svc4() {
    const { svc } = make();
    (svc as any).prisma.task = { findMany: async () => FOUR, count: async () => FOUR.length, findUnique: async ({ where }: any) => FOUR.find((t) => t.id === where.id) || null };
    (svc as any).prisma.taskClaim = { findFirst: async () => null, findMany: async () => [] };
    return svc;
  }

  it('one job named, one row', async () => {
    const svc = svc4();
    await svc.record({ contactId: 'c1', text: 'ZigBee protocol testing is done', channel: 'whatsapp' });
    const items: any[] = (await svc.inbox()).items;
    expect(items.map((i) => i.task.id)).toEqual(['zigbee']);
  });

  it('two named, two rows', async () => {
    const svc = svc4();
    await svc.record({ contactId: 'c1', text: 'ZigBee protocol testing done, and the socket pins plan is finished', channel: 'whatsapp' });
    const items: any[] = (await svc.inbox()).items;
    expect(items.map((i) => i.task.id).sort()).toEqual(['pins', 'zigbee']);
  });

  it('names nothing recognisable — shows them all rather than dropping the lot', async () => {
    const svc = svc4();
    await svc.record({ contactId: 'c1', text: 'all done', channel: 'whatsapp' });
    const items: any[] = (await svc.inbox()).items;
    expect(items).toHaveLength(4);
  });
});

/**
 * From Deepthi's real message: she wrote "PCBs also sent for prop…" about a job called "Send status
 * update on the PCB order". Without matching the plural it named nothing, and the job would never
 * have appeared for a ruling.
 */
describe('plurals are the same word', () => {
  it('"PCBs" names the "PCB order" job', async () => {
    const { svc } = make();
    const tasks = [
      { id: 'pcb', title: 'Send status update on the PCB order', status: 'open' },
      { id: 'geyser', title: 'Send status update on the geyser components order', status: 'open' },
    ];
    (svc as any).prisma.task = { findMany: async () => tasks, count: async () => tasks.length, findUnique: async ({ where }: any) => tasks.find((t) => t.id === where.id) || null };
    (svc as any).prisma.taskClaim = { findFirst: async () => null, findMany: async () => [] };
    await svc.record({ contactId: 'c1', text: 'All geyser components received. PCBs also sent for prototyping, done', channel: 'whatsapp' });
    const ids = (await svc.inbox()).items.map((i: any) => i.task.id).sort();
    expect(ids).toEqual(['geyser', 'pcb']);
  });
});
