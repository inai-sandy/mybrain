import { TriggersService } from './triggers.service';
import { findEcho } from './echo-guard';
import { parseServiceEventId, serviceEventId, vendorTriggerSlug } from '../tools/service-provider';

/**
 * BEA-1350 — a service event starts a flow, and the two guards that stop it eating itself.
 *
 * The properties worth locking down, in the order they matter:
 *  1. **The secret is the only door.** A wrong or missing one is rejected and NOTHING runs.
 *  2. **The echo guard** — proven in the real shape: our own Slack call is written to the flight
 *     recorder, the matching "new message" event is then posted, and the flow must NOT run.
 *  3. **The rate cap** — the binding pauses itself, says why, takes its subscription away and tells
 *     the owner. It never keeps firing quietly.
 *  4. **No orphans** — switching a rule off or throwing it away removes the subscription at the
 *     provider, so nothing goes on billing events for a rule that no longer exists.
 *  5. A flow that fails leaves the rule ON, with the failure visible in its history.
 */

const SECRET = 'a'.repeat(48);

/** A real Slack event, in the shape the provider posts. */
const slackMessageEvent = (text = 'hello from the agent', ts = '1718700000.123456') => ({
  type: 'composio.trigger.message',
  data: {
    trigger_id: 'ti_slack_1',
    trigger_slug: 'SLACK_RECEIVE_MESSAGE',
    toolkit_slug: 'slack',
    user_id: 'mybrain-owner',
    payload: { channel: 'C123', text, ts, user: 'U999' },
  },
});

function store() {
  const db: any = { triggerBinding: [], triggerEvent: [], toolCall: [], flow: [{ id: 'flow1', name: 'Triage it' }], setting: [{ key: 'triggers.secret', value: SECRET }] };
  const match = (row: any, where: any): boolean => {
    for (const [k, v] of Object.entries(where || {})) {
      const val = row[k];
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in (v as any) && !(v as any).in.includes(val)) return false;
        if ('gte' in (v as any) && !(val >= (v as any).gte)) return false;
        if ('notIn' in (v as any) && (v as any).notIn.includes(val)) return false;
        continue;
      }
      if (val !== v) return false;
    }
    return true;
  };
  const table = (name: string) => ({
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      let rows = db[name].filter((r: any) => match(r, where));
      if (orderBy?.createdAt === 'desc') rows = [...rows].sort((a, b) => +b.createdAt - +a.createdAt);
      if (skip) rows = rows.slice(skip);
      return take ? rows.slice(0, take) : rows;
    },
    findFirst: async ({ where, orderBy }: any = {}) => {
      let rows = db[name].filter((r: any) => match(r, where));
      if (orderBy?.createdAt === 'desc') rows = [...rows].sort((a, b) => +b.createdAt - +a.createdAt);
      return rows[0] || null;
    },
    findUnique: async ({ where }: any) => db[name].find((r: any) => match(r, where)) || null,
    count: async ({ where }: any = {}) => db[name].filter((r: any) => match(r, where)).length,
    create: async ({ data }: any) => {
      const row = { id: data.id || `${name}_${db[name].length + 1}`, createdAt: new Date(), ...data };
      db[name].push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = db[name].find((r: any) => match(r, where));
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }: any) => {
      const i = db[name].findIndex((r: any) => match(r, where));
      return db[name].splice(i, 1)[0];
    },
    deleteMany: async ({ where }: any = {}) => {
      const keep = db[name].filter((r: any) => !match(r, where));
      const n = db[name].length - keep.length;
      db[name] = keep;
      return { count: n };
    },
    upsert: async ({ where, create, update }: any) => {
      const row = db[name].find((r: any) => match(r, where));
      if (row) { Object.assign(row, update); return row; }
      const made = { createdAt: new Date(), ...create };
      db[name].push(made);
      return made;
    },
  });
  // One stable object per table, so a test can put a spy on a single call the way the real client
  // would let it.
  const prisma: any = {};
  for (const name of ['triggerBinding', 'triggerEvent', 'toolCall', 'flow', 'setting']) prisma[name] = table(name);
  return { db, prisma };
}

function harness(over: any = {}) {
  const { db, prisma } = store();
  const provider: any = {
    listTriggers: jest.fn(async (svc: string) => over.triggers ?? (svc === 'sentry' ? [] : [{ id: 'evt:slack.receive_message', name: 'New message', service: 'slack', instant: true, config: {} }])),
    createTriggerInstance: jest.fn(async () => over.created ?? { ok: true, instanceId: 'ti_slack_1' }),
    deleteTriggerInstance: jest.fn(async () => over.deleted ?? { ok: true }),
    ensureEventDelivery: jest.fn(async () => over.delivery ?? { ok: true, url: 'https://mybrain.1site.ai/x', signingSecret: 'whsec_test' }),
  };
  const runner: any = { start: jest.fn(async () => over.start ?? { runId: 'run_1' }) };
  if (over.startThrows) runner.start = jest.fn(async () => { throw new Error(over.startThrows); });
  const telegram: any = { notifyTriggerPaused: jest.fn(async () => undefined) };
  const svc = new TriggersService(prisma, provider, runner, telegram);
  return { svc, db, prisma, provider, runner, telegram };
}

/** One live rule: Slack's "new message" starts flow1. */
async function withBinding(h: ReturnType<typeof harness>, over: any = {}) {
  const r = await h.svc.create({ service: 'slack', triggerType: 'evt:slack.receive_message', flowId: 'flow1', ...over });
  expect(r.ok).toBe(true);
  return h.db.triggerBinding[0];
}

describe('the secret is the only door (BEA-1350)', () => {
  it('a valid secret starts the bound flow, with the event as the material it works on', async () => {
    const h = harness();
    await withBinding(h);
    const res = await h.svc.handle({ secret: SECRET, body: slackMessageEvent('a customer asked about pricing') });

    expect(res.status).toBe('ran');
    expect(h.runner.start).toHaveBeenCalledTimes(1);
    const [flowId, opts] = h.runner.start.mock.calls[0];
    expect(flowId).toBe('flow1');
    // The payload IS the flow's input — not a note that something happened somewhere.
    expect(opts.input).toContain('a customer asked about pricing');
    expect(opts.input).toContain('Slack');
    expect(h.db.triggerEvent[0]).toMatchObject({ status: 'ran', runId: 'run_1' });
  });

  it('a wrong secret is rejected and nothing runs', async () => {
    const h = harness();
    await withBinding(h);
    const res = await h.svc.handle({ secret: 'b'.repeat(48), body: slackMessageEvent() });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('rejected');
    expect(h.runner.start).not.toHaveBeenCalled();
    expect(h.db.triggerEvent).toHaveLength(0);
  });

  it('a missing secret is rejected too — and so is one of a different length', async () => {
    const h = harness();
    await withBinding(h);
    for (const secret of [undefined, '', 'short', `${SECRET}x`]) {
      expect((await h.svc.handle({ secret: secret as any, body: slackMessageEvent() })).status).toBe('rejected');
    }
    expect(h.runner.start).not.toHaveBeenCalled();
  });

  it('the secret never appears in what the page is told — only whether delivery is set up', async () => {
    const h = harness();
    const status = await h.svc.status();
    expect(JSON.stringify(status)).not.toContain(SECRET.slice(0, 20));
    expect(status.url).toContain('/api/tools/triggers/events/');
  });
});

describe('the echo guard — an event we caused ourselves never wakes the flow (BEA-1350)', () => {
  /**
   * The real shape of the loop: the agent posts to Slack, Slack tells us there is a new message, and
   * without this guard the flow posts again, for ever.
   */
  it('our own Slack post comes back as an event, and the flow does NOT run', async () => {
    const h = harness();
    const binding = await withBinding(h);

    // 1. We post to Slack. The flight recorder writes the row it always writes (BEA-1347).
    await h.prisma.toolCall.create({
      data: {
        runId: 'run_earlier', runKind: 'flow', service: 'slack', action: 'svc:slack.send_message',
        arguments: '{"channel":"C123","text":"hello from the agent"}',
        result: '{"ok":true,"ts":"1718700000.123456","channel":"C123"}',
        ok: true, createdAt: new Date(),
      },
    });

    // 2. Slack tells us about it.
    const res = await h.svc.handle({ secret: SECRET, body: slackMessageEvent('hello from the agent') });

    // 3. Nothing runs, and the drop is on the record with the call it blamed.
    expect(res.status).toBe('echo');
    expect(h.runner.start).not.toHaveBeenCalled();
    const row = h.db.triggerEvent.find((e: any) => e.bindingId === binding.id);
    expect(row.status).toBe('echo');
    expect(row.echoOfId).toBe(h.db.toolCall[0].id);
    expect(row.detail).toContain('We did this ourselves');
  });

  /**
   * The trap in BEA-1349's handover: `ToolCall` now carries Chat's rows too. A message the owner
   * sent from Chat echoes back exactly like one an agent sent, so the guard must NOT filter on
   * `runKind` — if it did, this event would go straight through and start the loop.
   */
  it('a call CHAT made echoes too — the guard never filters on the kind of run', async () => {
    const h = harness();
    await withBinding(h);
    await h.prisma.toolCall.create({
      data: {
        // On a chat row, runId is a chat SESSION and nodeId is a message — joining them to a run
        // would be garbage, which is exactly why the guard reads neither.
        runId: 'session_abc', runKind: 'chat', nodeId: 'msg_1', service: 'slack', action: 'svc:slack.send_message',
        result: '{"ok":true,"ts":"9999.1"}', ok: true, createdAt: new Date(),
      },
    });
    const res = await h.svc.handle({ secret: SECRET, body: slackMessageEvent('sent from chat') });
    expect(res.status).toBe('echo');
    expect(h.runner.start).not.toHaveBeenCalled();
  });

  it('an event nobody caused still runs — the guard is not just "drop everything"', async () => {
    const h = harness();
    await withBinding(h);
    // We created an issue on GitHub a moment ago. That has nothing to do with a Slack message.
    await h.prisma.toolCall.create({
      data: { service: 'github', action: 'svc:github.create_an_issue', result: '{"number":7}', ok: true, createdAt: new Date() },
    });
    const res = await h.svc.handle({ secret: SECRET, body: slackMessageEvent('a real person typed this') });
    expect(res.status).toBe('ran');
    expect(h.runner.start).toHaveBeenCalledTimes(1);
  });

  it('an old call of ours is not blamed for a fresh event', async () => {
    const h = harness();
    await withBinding(h);
    await h.prisma.toolCall.create({
      data: { service: 'slack', action: 'svc:slack.send_message', result: '{"ok":true}', ok: true, createdAt: new Date(Date.now() - 3 * 60 * 60_000) },
    });
    expect((await h.svc.handle({ secret: SECRET, body: slackMessageEvent() })).status).toBe('ran');
  });

  it('a call that FAILED is never blamed — nothing left the building, so nothing can echo', () => {
    const failed = [{ id: 'c1', service: 'slack', action: 'svc:slack.send_message', ok: false, result: null, createdAt: new Date() }];
    expect(findEcho({ triggerType: 'evt:slack.receive_message', payload: { text: 'hi' } }, failed).echo).toBe(false);
  });

  it('a READ is never blamed — listing messages cannot have created one', () => {
    const reads = [{ id: 'c1', service: 'slack', action: 'svc:slack.search_messages', ok: true, result: '{"ok":true}', createdAt: new Date() }];
    expect(findEcho({ triggerType: 'evt:slack.receive_message', payload: { text: 'hi' } }, reads).echo).toBe(false);
  });

  it('catches it on identity alone, even when the words do not line up', () => {
    const calls = [{ id: 'c1', service: 'github', action: 'svc:github.create_a_commit', ok: true, result: '{"sha":"9f2c1ab77e5"}', createdAt: new Date() }];
    const v = findEcho({ triggerType: 'evt:github.star_added_event', payload: { head: { sha: '9f2c1ab77e5' } } }, calls);
    expect(v.echo).toBe(true);
    expect(v.callId).toBe('c1');
  });
});

describe('the rate cap — a rule that runs away pauses itself (BEA-1350)', () => {
  it('past its cap it stops listening, records why, drops the subscription and tells the owner', async () => {
    const h = harness();
    const binding = await withBinding(h, { rateCap: 3 });
    for (let i = 0; i < 3; i++) {
      await h.prisma.triggerEvent.create({ data: { bindingId: binding.id, service: 'slack', status: 'ran', createdAt: new Date() } });
    }

    const res = await h.svc.handle({ secret: SECRET, body: slackMessageEvent(`unrelated ${Math.random()}`) });

    expect(res.status).toBe('capped');
    expect(h.runner.start).not.toHaveBeenCalled();
    const row = h.db.triggerBinding[0];
    expect(row.enabled).toBe(false);
    expect(row.pausedReason).toContain('over its limit of 3');
    // No orphan: the subscription at the provider goes when the rule stops listening.
    expect(h.provider.deleteTriggerInstance).toHaveBeenCalledWith('ti_slack_1');
    expect(row.triggerInstanceId).toBeNull();
    // Pushed, because nobody is watching a background rule.
    expect(h.telegram.notifyTriggerPaused).toHaveBeenCalled();
    expect(h.db.triggerEvent.find((e: any) => e.status === 'capped').detail).toContain('Nothing ran');
  });

  it('under the cap it just runs, and only real runs count towards it', async () => {
    const h = harness();
    const binding = await withBinding(h, { rateCap: 2 });
    // An echo and an ignored event are not runs — they must not use up the allowance.
    for (const status of ['echo', 'ignored', 'capped']) {
      await h.prisma.triggerEvent.create({ data: { bindingId: binding.id, service: 'slack', status, createdAt: new Date() } });
    }
    expect((await h.svc.handle({ secret: SECRET, body: slackMessageEvent('a person typed this') })).status).toBe('ran');
    expect(h.db.triggerBinding[0].enabled).toBe(true);
  });

  it("an hour-old run does not count — the cap is per hour, not for ever", async () => {
    const h = harness();
    const binding = await withBinding(h, { rateCap: 1 });
    await h.prisma.triggerEvent.create({ data: { bindingId: binding.id, service: 'slack', status: 'ran', createdAt: new Date(Date.now() - 90 * 60_000) } });
    expect((await h.svc.handle({ secret: SECRET, body: slackMessageEvent('fresh') })).status).toBe('ran');
  });

  it('the default cap is 20 an hour', async () => {
    const h = harness();
    expect((await withBinding(h)).rateCap).toBe(20);
  });

  /**
   * The cap is a read-then-write, and the webhook answers before it does the work — so a burst
   * arrives as several overlapping calls. Without a queue per rule they would all read the same
   * under-the-limit count and all run, which is precisely the runaway the cap exists to stop.
   */
  it('a burst arriving at once cannot slip past the cap', async () => {
    const h = harness({ rateCap: 2 });
    await withBinding(h, { rateCap: 2 });
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => h.svc.handle({ secret: SECRET, body: slackMessageEvent(`a person typed this ${i}`) })));
    expect(results.filter((r) => r.status === 'ran')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'capped').length).toBeGreaterThan(0);
    expect(h.runner.start).toHaveBeenCalledTimes(2);
    expect(h.db.triggerBinding[0].enabled).toBe(false);
  });

  it('once it has paused itself, the events still in the queue do not run either', async () => {
    const h = harness();
    const binding = await withBinding(h, { rateCap: 1 });
    await Promise.all([1, 2, 3].map((i) => h.svc.handle({ secret: SECRET, body: slackMessageEvent(`a person typed this ${i}`) })));
    expect(h.runner.start).toHaveBeenCalledTimes(1);
    expect(h.db.triggerEvent.filter((e: any) => e.bindingId === binding.id && e.status === 'ran')).toHaveLength(1);
  });
});

describe('no orphans left behind at the provider (BEA-1350)', () => {
  it('switching a rule off removes the subscription', async () => {
    const h = harness();
    const binding = await withBinding(h);
    const r = await h.svc.update(binding.id, { enabled: false });
    expect(r.ok).toBe(true);
    expect(h.provider.deleteTriggerInstance).toHaveBeenCalledWith('ti_slack_1');
    expect(h.db.triggerBinding[0].triggerInstanceId).toBeNull();
  });

  it('switching it back on makes a fresh one', async () => {
    const h = harness();
    const binding = await withBinding(h);
    await h.svc.update(binding.id, { enabled: false });
    await h.svc.update(binding.id, { enabled: true });
    expect(h.provider.createTriggerInstance).toHaveBeenCalledTimes(2);
    expect(h.db.triggerBinding[0].enabled).toBe(true);
    expect(h.db.triggerBinding[0].pausedReason).toBeNull();
  });

  it('throwing a rule away removes the subscription and its history', async () => {
    const h = harness();
    const binding = await withBinding(h);
    await h.svc.handle({ secret: SECRET, body: slackMessageEvent('a person typed this') });
    expect(h.db.triggerEvent.length).toBeGreaterThan(0);

    expect((await h.svc.remove(binding.id)).ok).toBe(true);
    expect(h.provider.deleteTriggerInstance).toHaveBeenCalledWith('ti_slack_1');
    expect(h.db.triggerBinding).toHaveLength(0);
    expect(h.db.triggerEvent).toHaveLength(0);
  });

  /** The dangerous half: a row deleted while the provider is still sending IS the orphan. */
  it('when the provider will not stop, the rule is kept and the owner is told', async () => {
    const h = harness({ deleted: { ok: false, message: 'Composio did not answer in time.' } });
    const binding = await withBinding(h);
    const r = await h.svc.remove(binding.id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('nothing was changed');
    expect(h.db.triggerBinding).toHaveLength(1);
  });

  /** And the other way round: no row is written for a subscription that was never made. */
  it('a rule is not saved when the provider refuses to start listening', async () => {
    const h = harness({ created: { ok: false, message: 'That repository does not exist.' } });
    const r = await h.svc.create({ service: 'slack', triggerType: 'evt:slack.receive_message', flowId: 'flow1' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('does not exist');
    expect(h.db.triggerBinding).toHaveLength(0);
  });

  /**
   * The orphan reached from the other side: the subscription was made, and OUR OWN write then
   * failed. Nothing would point at it ever again, so it has to come straight back down.
   */
  it('a subscription we make and then cannot record is taken back down', async () => {
    const h = harness();
    jest.spyOn(h.prisma.triggerBinding, 'create').mockRejectedValueOnce(new Error('database is locked'));
    const r = await h.svc.create({ service: 'slack', triggerType: 'evt:slack.receive_message', flowId: 'flow1' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('nothing is listening');
    expect(h.provider.deleteTriggerInstance).toHaveBeenCalledWith('ti_slack_1');
    expect(h.db.triggerBinding).toHaveLength(0);
  });

  it('the same holds when switching a rule back on', async () => {
    const h = harness();
    const binding = await withBinding(h);
    await h.svc.update(binding.id, { enabled: false });
    jest.spyOn(h.prisma.triggerBinding, 'update').mockRejectedValueOnce(new Error('database is locked'));
    const r = await h.svc.update(binding.id, { enabled: true });
    expect(r.ok).toBe(false);
    // Once for the switch-off, once for the subscription it could not record.
    expect(h.provider.deleteTriggerInstance).toHaveBeenCalledTimes(2);
    expect(h.db.triggerBinding[0].enabled).toBe(false);
  });
});

describe('what the owner sees afterwards (BEA-1350)', () => {
  it('a flow that will not start leaves the rule ON, with the failure in its history', async () => {
    const h = harness({ startThrows: 'Flow not found' });
    const binding = await withBinding(h);
    const res = await h.svc.handle({ secret: SECRET, body: slackMessageEvent('a person typed this') });
    expect(res.status).toBe('failed');
    expect(h.db.triggerBinding[0].enabled).toBe(true);
    const row = h.db.triggerEvent.find((e: any) => e.bindingId === binding.id);
    expect(row.status).toBe('failed');
    expect(row.detail).toContain('Flow not found');
  });

  it('a flow that was already running is said out loud, not counted as a fresh start', async () => {
    const h = harness({ start: { runId: 'run_live', joined: true } });
    await withBinding(h);
    const res = await h.svc.handle({ secret: SECRET, body: slackMessageEvent('a person typed this') });
    expect(res.status).toBe('busy');
    expect(h.db.triggerEvent[0].detail).toContain('already running');
  });

  it('an event nobody is listening for is written down, not silently dropped', async () => {
    const h = harness();
    const res = await h.svc.handle({ secret: SECRET, body: slackMessageEvent() });
    expect(res.status).toBe('ignored');
    expect(h.db.triggerEvent[0].detail).toContain('No rule is listening');
  });

  it('a switched-off rule ignores its events rather than running them', async () => {
    const h = harness();
    const binding = await withBinding(h);
    await h.svc.update(binding.id, { enabled: false });
    const res = await h.svc.handle({ secret: SECRET, body: slackMessageEvent('a person typed this') });
    expect(res.status).toBe('ignored');
    expect(h.runner.start).not.toHaveBeenCalled();
  });

  it('the provider switching a trigger off at its end pauses the rule and says so plainly', async () => {
    const h = harness();
    await withBinding(h);
    const res = await h.svc.handle({
      secret: SECRET,
      body: { type: 'composio.trigger.disabled', data: { trigger_id: 'ti_slack_1', toolkit_slug: 'slack', trigger_slug: 'SLACK_RECEIVE_MESSAGE' } },
    });
    expect(res.status).toBe('notice');
    expect(h.db.triggerBinding[0].enabled).toBe(false);
    expect(h.db.triggerBinding[0].pausedReason).toContain('sign-in may have expired');
    expect(h.telegram.notifyTriggerPaused).toHaveBeenCalled();
  });

  it('the history reads as English, with a line about the event itself', async () => {
    const h = harness();
    await withBinding(h);
    await h.svc.handle({ secret: SECRET, body: slackMessageEvent('the build is broken again') });
    const { events } = await h.svc.events(h.db.triggerBinding[0].id);
    expect(events[0]).toMatchObject({ status: 'ran', detail: 'It started the flow.' });
    expect(events[0].summary).toBe('the build is broken again');
  });
});

describe('a connected service may have no events at all (BEA-1350)', () => {
  it('says so with an empty list rather than failing', async () => {
    const h = harness();
    const sentry = await h.svc.available('sentry');
    expect(sentry.triggers).toEqual([]);
    const slack = await h.svc.available('slack');
    expect(slack.triggers).toHaveLength(1);
  });

  it('a provider that cannot list events at all is not a crash', async () => {
    const { prisma } = store();
    const svc = new TriggersService(prisma, {} as any, { start: jest.fn() } as any);
    expect((await svc.available('github')).triggers).toEqual([]);
  });
});

describe('event ids never carry a vendor name (BEA-1350)', () => {
  it('round-trips our id and the provider slug in both directions', () => {
    expect(serviceEventId('slack', 'SLACK_RECEIVE_MESSAGE')).toBe('evt:slack.receive_message');
    expect(vendorTriggerSlug('evt:slack.receive_message')).toBe('SLACK_RECEIVE_MESSAGE');
    // A service whose own slug has an underscore must not be cut in half.
    expect(serviceEventId('google_calendar', 'GOOGLE_CALENDAR_NEW_EVENT')).toBe('evt:google_calendar.new_event');
    expect(vendorTriggerSlug('evt:google_calendar.new_event')).toBe('GOOGLE_CALENDAR_NEW_EVENT');
    expect(parseServiceEventId('evt:github.pull_request_event')).toEqual({ service: 'github', trigger: 'pull_request_event' });
    expect(parseServiceEventId('svc:github.create_an_issue')).toBeNull();
  });
});
