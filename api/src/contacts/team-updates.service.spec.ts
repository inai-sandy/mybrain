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
    taskClaim: { findMany: async () => [] },
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
  function withClaim(claim: any | null) {
    const { svc, rows } = make();
    (svc as any).prisma.taskClaim = { findFirst: async () => claim, findMany: async () => [] };
    return { svc, rows };
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
    const { svc } = withClaim({ id: 'cl1' });
    await svc.record({ contactId: 'c1', text: 'It is completed', channel: 'whatsapp', taskId: 't1' });
    const id = (await svc.inbox()).items[0].id;
    const calls: any[] = [];
    const r: any = await svc.decide(id, true, async (claimId, ok) => { calls.push({ claimId, ok }); return { ok: true }; });
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
