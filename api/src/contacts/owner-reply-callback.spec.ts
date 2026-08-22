import { PostboxCallbackController } from './postbox-callback.controller';
import { setOwnerReplyHandler } from './owner-reply';
import { OwnerAskService } from '../worker/owner-ask.service';

/**
 * The dangerous road, driven the way it really works (BEA-1392 §H).
 *
 * Not a unit test of the matcher — the REAL `PostboxCallbackController` with the REAL
 * `OwnerAskService` registered on it, fed the shape Postbox really posts. This is the file that
 * has to be right: `postbox-callback.controller.ts` carries the owner's Contacts and Reminders
 * traffic every day, and the owner-number check now sits AHEAD of its Contact lookup. A mistake
 * here swallows a contact's reply.
 *
 * Three things are proved, in this order:
 *   1. an owner reply WITH an open question answers it — and touches nothing on the contact road;
 *   2. an owner reply with NO open question changes nothing at all;
 *   3. a CONTACT's reply behaves exactly as it did before this piece existed, even while a question
 *      is open — it is stored, the two-way agent is woken (which is the tap handler, the claims and
 *      the daily-report road), and the `whatsapp.reply` trigger fires.
 */

const OWNER = '919885698665';

/** What Postbox really posts for an inbound WhatsApp message. */
const inbound = (from: string, text: string, extra: any = {}) => ({
  kind: 'message',
  from,
  text,
  wamid: `wamid.HBgMOTE5${Math.random().toString(36).slice(2, 8)}`,
  replyToWamid: null,
  buttonId: null,
  timestamp: new Date().toISOString(),
  ...extra,
});

function world(opts: { contacts?: any[]; asks?: any[] } = {}) {
  const created: any[] = [];
  const agentCalls: string[] = [];
  const events: any[] = [];
  const steps: any[] = [];
  const contacts = opts.contacts || [];
  const asks = (opts.asks || []).map((a, i) => ({
    id: a.id || `wp${i + 1}`,
    runId: a.runId || `run${i + 1}`,
    question: a.question || 'Carry on?',
    options: a.options ?? ['Carry on', 'Stop'],
    status: 'pending',
    answer: null,
    answeredVia: null,
    askedVia: 'whatsapp',
    createdAt: a.createdAt || new Date(2026, 7, 20, 10, i),
  }));

  const prisma: any = {
    reminderMessage: { findFirst: async () => null, create: async ({ data }: any) => created.push(data) },
    deletedMessage: { findUnique: async () => null },
    contact: {
      findFirst: async ({ where }: any) => {
        if (typeof where.whatsappNumber === 'string') return contacts.find((c) => c.whatsappNumber === where.whatsappNumber) || null;
        const suffix = where.whatsappNumber?.endsWith;
        return suffix ? contacts.find((c) => c.whatsappNumber.endsWith(suffix)) || null : null;
      },
    },
  };
  const postbox: any = { callbackKey: 'k' };
  const reminderAgent: any = { onContactReply: async (id: string) => { agentCalls.push(id); } };
  const appEvents: any = { emit: (name: string, payload: any) => events.push({ name, payload }) };

  // The real question road, with only the WhatsApp send itself faked.
  const agent: any = {
    openWhatsAppAsks: async () => asks.filter((a) => a.status === 'pending'),
    answerById: async (id: string, answer: unknown, via: string) => {
      const wp = asks.find((a) => a.id === id);
      if (!wp || wp.status !== 'pending') return { applied: false, alreadyResolved: true };
      wp.status = 'answered';
      wp.answer = answer;
      wp.answeredVia = via;
      return { applied: true };
    },
    appendStep: async (runId: string, s: any) => { steps.push({ runId, ...s }); },
  };
  const alerts: any = { ownerNumber: async () => OWNER };
  const owner = new OwnerAskService(agent, alerts);
  owner.onModuleInit(); // this is what registers it on the controller's registry, at boot

  const ctrl = new PostboxCallbackController(prisma, postbox, reminderAgent, appEvents);
  return { ctrl, created, agentCalls, events, steps, asks };
}

afterEach(() => setOwnerReplyHandler(null));

describe("the owner's own reply (BEA-1392)", () => {
  it('answers the open question — and writes nothing on the contact road', async () => {
    const w = world({ asks: [{ id: 'wpA', runId: 'runA', question: 'Write these 12 rows to the sheet?' }] });
    const res = await w.ctrl.callback(inbound(OWNER, '1'), 'k');

    expect(res).toMatchObject({ ok: true, answered: true });
    expect(w.asks[0].status).toBe('answered');
    expect(w.asks[0].answer).toBe('Carry on'); // "1" is the first numbered choice
    expect(w.asks[0].answeredVia).toBe('whatsapp');
    expect(w.steps.map((s) => s.label).join(' ')).toContain('You answered on WhatsApp');
    // Nothing of the reminders road happened.
    expect(w.created).toHaveLength(0);
    expect(w.agentCalls).toHaveLength(0);
    expect(w.events).toHaveLength(0);
  });

  it('answers the question he named by its tag, not the oldest one', async () => {
    const w = world({
      asks: [
        { id: 'aaa1', runId: 'runOld', createdAt: new Date(2026, 7, 20, 9) },
        { id: 'bbb2', runId: 'runNew', createdAt: new Date(2026, 7, 21, 9) },
      ],
    });
    await w.ctrl.callback(inbound(OWNER, '#bbb 2'), 'k');
    expect(w.asks[0].status).toBe('pending');
    expect(w.asks[1].status).toBe('answered');
    expect(w.asks[1].answer).toBe('Stop');
  });

  it('with NO open question, nothing changes and no junk is written', async () => {
    const w = world({ asks: [] });
    const res = await w.ctrl.callback(inbound(OWNER, 'hello'), 'k');
    expect(res).toEqual({ ok: true }); // not "answered"
    expect(w.created).toHaveLength(0);
    expect(w.agentCalls).toHaveLength(0);
    expect(w.events).toHaveLength(0);
    expect(w.steps).toHaveLength(0);
  });

  it('his number saved as a Contact still behaves exactly as before when nothing is open', async () => {
    // Falling through is the point: the owner-number check only intercepts an OPEN question.
    const w = world({ asks: [], contacts: [{ id: 'cOwner', name: 'Me', whatsappNumber: OWNER }] });
    await w.ctrl.callback(inbound(OWNER, 'done'), 'k');
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({ contactId: 'cOwner', direction: 'in', body: 'done' });
    expect(w.agentCalls).toEqual(['cOwner']);
  });

  it('a retried callback of the same message never answers a SECOND question', async () => {
    const w = world({
      asks: [
        { id: 'aaa1', runId: 'runA', createdAt: new Date(2026, 7, 20, 9) },
        { id: 'bbb2', runId: 'runB', createdAt: new Date(2026, 7, 20, 10) },
      ],
    });
    const body = inbound(OWNER, '1');
    await w.ctrl.callback(body, 'k');
    await w.ctrl.callback(body, 'k'); // Postbox retries what it thinks was not taken
    expect(w.asks[0].status).toBe('answered');
    expect(w.asks[1].status).toBe('pending'); // the second question is untouched
  });

  it('a tag with nothing after it is not an answer — the question stays open', async () => {
    const w = world({ asks: [{ id: 'aaa1', runId: 'runA' }] });
    await w.ctrl.callback(inbound(OWNER, '#aaa'), 'k');
    expect(w.asks[0].status).toBe('pending');
  });
});

describe("a CONTACT's reply reaches Contacts and Reminders exactly as it does today", () => {
  it('is stored on the contact, wakes the two-way agent, and fires the trigger — while a question is open', async () => {
    const w = world({
      contacts: [{ id: 'c1', name: 'Ravi', whatsappNumber: '8885551234' }],
      asks: [{ id: 'wpA', runId: 'runA' }], // a worker IS waiting — and must not hear this
    });
    const body = inbound('918885551234', 'done', { buttonId: 'done_task_9', replyToWamid: 'wamid.OUT1' });
    const res = await w.ctrl.callback(body, 'k');

    expect(res).toEqual({ ok: true });
    // Exactly today's behaviour, field for field (BEA-742 · BEA-787 · BEA-1300).
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({
      contactId: 'c1',
      direction: 'in',
      body: 'done',
      wamid: body.wamid,
      replyToWamid: 'wamid.OUT1',
      buttonId: 'done_task_9',
    });
    // The two-way agent — the tap handler, the claims and the daily-report road all hang off it.
    expect(w.agentCalls).toEqual(['c1']);
    expect(w.events[0].name).toBe('whatsapp.reply');
    expect(w.events[0].payload).toMatchObject({ contactId: 'c1' });
    // And the worker's question is untouched: a contact can never answer it.
    expect(w.asks[0].status).toBe('pending');
    expect(w.steps).toHaveLength(0);
  });

  it('an unknown number still does nothing, question open or not', async () => {
    const w = world({ contacts: [{ id: 'c1', whatsappNumber: '919999999999' }], asks: [{ id: 'wpA', runId: 'runA' }] });
    await w.ctrl.callback(inbound('918885551234', 'hello'), 'k');
    expect(w.created).toHaveLength(0);
    expect(w.agentCalls).toHaveLength(0);
    expect(w.asks[0].status).toBe('pending');
  });

  it('the whole road is unchanged on a server with no worker wired at all', async () => {
    setOwnerReplyHandler(null); // no OwnerAskService registered — the old code path exactly
    const w = world({ contacts: [{ id: 'c1', whatsappNumber: '8885551234' }] });
    setOwnerReplyHandler(null);
    await w.ctrl.callback(inbound('918885551234', 'done'), 'k');
    expect(w.created).toHaveLength(1);
    expect(w.agentCalls).toEqual(['c1']);
  });
});
