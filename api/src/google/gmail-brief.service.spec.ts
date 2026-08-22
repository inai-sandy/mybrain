import { GmailBriefService } from './gmail-brief.service';

/**
 * Gmail is read at two local times a day and at no other time in the background (BEA-1399):
 * 21:00 builds the early brief, 23:30 reads only what arrived after it. The 60-second tick checks
 * the CLOCK first — outside those windows it must never touch Google. Before this, the tick called
 * google.status() every minute (a quiet GET_PROFILE every 30 min that Composio counted and we did
 * not), and a missing yesterday-brief made it retry the whole read every minute.
 */
type Meta = { id: string; threadId: string; from: string; subject: string; date: string; snippet: string };

function make(opts: {
  hm: string;
  settings?: Record<string, string>;
  briefs?: Record<string, any>;
  important?: Meta[];
  since?: Meta[];
  unread?: number;
  now?: number;
}) {
  const settings: Record<string, string> = { ...(opts.settings || {}) };
  const briefs: Record<string, any> = { ...(opts.briefs || {}) };
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (where.key in settings ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => { settings[where.key] = update?.value ?? create?.value; return {}; },
    },
    gmailBrief: {
      findUnique: async ({ where }: any) => briefs[where.day] ?? null,
      upsert: async ({ where, create, update }: any) => { briefs[where.day] = { ...(briefs[where.day] || {}), ...(briefs[where.day] ? update : create), day: where.day }; return briefs[where.day]; },
      update: async ({ where, data }: any) => { if (!briefs[where.day]) throw new Error('no row'); briefs[where.day] = { ...briefs[where.day], ...data }; return briefs[where.day]; },
    },
  };
  const google: any = {
    status: jest.fn(async () => ({ connected: true, email: 'o@x.io' })),
    rememberEmail: jest.fn(async () => 'o@x.io'),
    gmailDayUnread: jest.fn(async () => opts.unread ?? 4),
    gmailImportantForDay: jest.fn(async () => opts.important ?? []),
    gmailImportantSince: jest.fn(async () => opts.since ?? []),
  };
  const llm: any = { completeWithModel: jest.fn(async () => ({ text: '{"overview":"ok","sections":[{"heading":"H","points":["p"],"emails":[1]}]}', model: 'm' })) };
  const emailMemory: any = { syncDay: jest.fn(async () => 0) };
  const memory: any = { indexEntity: jest.fn(async () => undefined) };
  const svc = new GmailBriefService(prisma, llm, google, memory, emailMemory, { get: async () => 'PROMPT' } as any);
  jest.spyOn(svc as any, 'tz').mockResolvedValue('Asia/Kolkata');
  jest.spyOn(svc as any, 'dayKey').mockReturnValue('2026-08-22');
  jest.spyOn(svc as any, 'localHM').mockReturnValue(opts.hm);
  jest.spyOn(svc as any, 'finalizeRecentBriefs').mockResolvedValue(undefined);
  const clock = { now: opts.now ?? 1_787_410_800 }; // 2026-08-22 21:00:00 IST
  jest.spyOn(svc as any, 'nowSeconds').mockImplementation(() => clock.now);
  return { svc, settings, briefs, google, llm, emailMemory, clock };
}

const mail = (id: string, subject = 'S' + id): Meta => ({ id, threadId: 't' + id, from: 'A <a@x.io>', subject, date: '2026-08-22T15:00:00Z', snippet: 'snip ' + id });

describe('GmailBriefService.briefTick — two windows a day, nothing in between (BEA-1399)', () => {
  it('outside the windows the tick touches nothing at Google — no status probe, no read', async () => {
    const { svc, google } = make({ hm: '10:15', briefs: { '2026-08-21': { day: '2026-08-21' } } });
    const gen = jest.spyOn(svc, 'generate');
    await svc.briefTick();
    await svc.briefTick();
    expect(google.status).not.toHaveBeenCalled();
    expect(google.gmailDayUnread).not.toHaveBeenCalled();
    expect(google.gmailImportantForDay).not.toHaveBeenCalled();
    expect(gen).not.toHaveBeenCalled();
  });

  it('at 21:00 the early pass builds the full brief once, pushes, remembers when it ran — a second tick does nothing', async () => {
    const { svc, settings, google } = make({ hm: '21:00', important: [mail('1'), mail('2')] });
    await svc.briefTick();
    expect(google.gmailImportantForDay).toHaveBeenCalledWith('2026-08-22', 25);
    expect(settings['gmailbrief.earlyDone']).toBe('2026-08-22');
    expect(settings['gmailbrief.earlyAt']).toBe('1787410800');
    expect(settings['telegram.pushGmailBrief']).toBe('2026-08-22');
    (google.gmailImportantForDay as jest.Mock).mockClear();
    await svc.briefTick();
    expect(google.gmailImportantForDay).not.toHaveBeenCalled();
  });

  it('the early pass keeps the mails it read, so the final pass can re-summarise without reading them again', async () => {
    const { svc, settings } = make({ hm: '21:00', important: [mail('1'), mail('2')] });
    await svc.briefTick();
    expect(JSON.parse(settings['gmailbrief.earlyMetas']).map((m: Meta) => m.id)).toEqual(['1', '2']);
  });

  it('at 23:30 the final pass reads only mail after the early pass; nothing new → unread refreshed, no push, no memory sync', async () => {
    const { svc, settings, google, llm, emailMemory, briefs } = make({
      hm: '23:30',
      settings: { 'gmailbrief.earlyDone': '2026-08-22', 'gmailbrief.earlyAt': '1787410800', 'gmailbrief.earlyMetas': JSON.stringify([mail('1')]) },
      briefs: { '2026-08-22': { day: '2026-08-22', unread: 4, summary: 'early', items: '[]', sections: '[]' } },
      since: [],
      unread: 9,
    });
    await svc.briefTick();
    expect(google.gmailImportantSince).toHaveBeenCalledWith('2026-08-22', 1787410800, 25);
    expect(google.gmailImportantForDay).not.toHaveBeenCalled();
    expect(llm.completeWithModel).not.toHaveBeenCalled();
    expect(emailMemory.syncDay).not.toHaveBeenCalled();
    expect(settings['telegram.pushGmailBrief']).toBeUndefined();
    expect(briefs['2026-08-22'].unread).toBe(9);
    expect(settings['gmailbrief.nightlyDone']).toBe('2026-08-22');
  });

  it('at 23:30 with new mail the final pass re-summarises early + new together, pushes again, and syncs only the new mails', async () => {
    const { svc, settings, llm, emailMemory, briefs } = make({
      hm: '23:30',
      settings: { 'gmailbrief.earlyDone': '2026-08-22', 'gmailbrief.earlyAt': '1787410800', 'gmailbrief.earlyMetas': JSON.stringify([mail('1', 'Early one')]) },
      briefs: { '2026-08-22': { day: '2026-08-22', unread: 4, summary: 'early', items: '[]', sections: '[]' } },
      since: [mail('2', 'Late one')],
    });
    await svc.briefTick();
    const prompt = (llm.completeWithModel as jest.Mock).mock.calls[0][1] as string;
    expect(prompt).toContain('Late one');
    expect(prompt).toContain('Early one');
    expect(settings['telegram.pushGmailBrief']).toBe('2026-08-22');
    expect(emailMemory.syncDay).toHaveBeenCalledTimes(1);
    expect((emailMemory.syncDay as jest.Mock).mock.calls[0][1].map((m: Meta) => m.id)).toEqual(['2']);
    expect(JSON.parse(briefs['2026-08-22'].items)).toHaveLength(2);
  });

  it('at 23:30 with no early pass behind it (restart), the final pass does the full read', async () => {
    const { svc, google, settings } = make({ hm: '23:40', important: [mail('1')] });
    await svc.briefTick();
    expect(google.gmailImportantForDay).toHaveBeenCalledWith('2026-08-22', 25);
    expect(google.gmailImportantSince).not.toHaveBeenCalled();
    expect(settings['telegram.pushGmailBrief']).toBe('2026-08-22');
    expect(settings['gmailbrief.nightlyDone']).toBe('2026-08-22');
  });

  it('does not rebuild or re-push once the final marker is set for today (BEA-803)', async () => {
    const { svc, google } = make({ hm: '23:59', settings: { 'gmailbrief.nightlyDone': '2026-08-22' } });
    await svc.briefTick();
    expect(google.gmailImportantForDay).not.toHaveBeenCalled();
    expect(google.gmailImportantSince).not.toHaveBeenCalled();
  });

  it('a missed night is caught up ONCE the next morning — never retried every minute', async () => {
    const { svc, google, settings } = make({ hm: '08:00', important: [mail('1')] });
    await svc.briefTick();
    expect(google.gmailImportantForDay).toHaveBeenCalledWith('2026-08-21', 25);
    expect(settings['gmailbrief.catchupTried']).toBe('2026-08-22');
    (google.gmailImportantForDay as jest.Mock).mockClear();
    await svc.briefTick();
    await svc.briefTick();
    expect(google.gmailImportantForDay).not.toHaveBeenCalled();
  });

  it('a failing read never pretends — no "no important emails" brief, no push — and is not retried the next minute', async () => {
    const { svc, google, settings, briefs, clock } = make({ hm: '21:05' });
    (google.gmailImportantForDay as jest.Mock).mockRejectedValue(new Error('gmail-cap:60:60'));
    (google.gmailDayUnread as jest.Mock).mockRejectedValue(new Error('gmail-cap:60:60'));
    await svc.briefTick();
    clock.now += 60;
    await svc.briefTick();
    expect(google.gmailImportantForDay).toHaveBeenCalledTimes(1);
    expect(briefs['2026-08-22']).toBeUndefined();
    expect(settings['telegram.pushGmailBrief']).toBeUndefined();
  });
});

describe('GmailBriefService.briefTick — a pass that fails does not burn the window (BEA-1412)', () => {
  it('a failing early pass is retried after 2 minutes, not the next minute, and gives up after 3 tries', async () => {
    const { svc, google, settings, clock } = make({ hm: '21:05' });
    (google.gmailImportantForDay as jest.Mock).mockRejectedValue(new Error('not-connected:gmail'));
    await svc.briefTick(); // try 1
    expect(google.gmailImportantForDay).toHaveBeenCalledTimes(1);
    expect(settings['gmailbrief.earlyDone']).toBeUndefined();
    clock.now += 60;
    await svc.briefTick(); // too soon
    expect(google.gmailImportantForDay).toHaveBeenCalledTimes(1);
    clock.now += 70;
    await svc.briefTick(); // try 2
    expect(google.gmailImportantForDay).toHaveBeenCalledTimes(2);
    clock.now += 130;
    await svc.briefTick(); // try 3 — the last
    expect(google.gmailImportantForDay).toHaveBeenCalledTimes(3);
    expect(settings['gmailbrief.earlyDone']).toBe('2026-08-22');
    clock.now += 200;
    await svc.briefTick();
    expect(google.gmailImportantForDay).toHaveBeenCalledTimes(3);
  });

  it('a success after a failure marks the window done and pushes once', async () => {
    const { svc, google, settings, clock } = make({ hm: '21:05', important: [mail('1')] });
    (google.gmailImportantForDay as jest.Mock).mockRejectedValueOnce(new Error('not-connected:gmail'));
    await svc.briefTick();
    expect(settings['gmailbrief.earlyDone']).toBeUndefined();
    expect(settings['telegram.pushGmailBrief']).toBeUndefined();
    clock.now += 125;
    await svc.briefTick();
    expect(settings['gmailbrief.earlyDone']).toBe('2026-08-22');
    expect(settings['telegram.pushGmailBrief']).toBe('2026-08-22');
    clock.now += 125;
    await svc.briefTick();
    expect(google.gmailImportantForDay).toHaveBeenCalledTimes(2);
  });

  it('the final pass has the same bounded retry', async () => {
    const { svc, google, settings, clock } = make({ hm: '23:31' });
    (google.gmailImportantForDay as jest.Mock).mockRejectedValue(new Error('fetch failed'));
    await svc.briefTick();
    expect(settings['gmailbrief.nightlyDone']).toBeUndefined();
    clock.now += 30;
    await svc.briefTick();
    expect(google.gmailImportantForDay).toHaveBeenCalledTimes(1);
    clock.now += 100;
    await svc.briefTick();
    expect(google.gmailImportantForDay).toHaveBeenCalledTimes(2);
  });

  it('no pass in the first 90 s after boot — the provider is not warm yet; the next tick takes the window', async () => {
    const { svc, google, clock } = make({ hm: '22:59', important: [mail('1')] });
    svc.onModuleInit();
    try {
      clock.now += 30;
      await svc.briefTick();
      expect(google.gmailImportantForDay).not.toHaveBeenCalled();
      clock.now += 70;
      await svc.briefTick();
      expect(google.gmailImportantForDay).toHaveBeenCalledTimes(1);
    } finally {
      svc.onModuleDestroy();
    }
  });
});

describe('GmailBriefService.briefTick — review fixes (BEA-1412)', () => {
  it('the morning catch-up also waits out the boot grace, and its one chance is not spent on a cold provider', async () => {
    const { svc, google, settings, clock } = make({ hm: '08:00', important: [mail('1')] });
    svc.onModuleInit();
    try {
      clock.now += 30;
      await svc.briefTick();
      expect(google.gmailImportantForDay).not.toHaveBeenCalled();
      expect(settings['gmailbrief.catchupTried']).toBeUndefined();
      clock.now += 70;
      await svc.briefTick();
      expect(google.gmailImportantForDay).toHaveBeenCalledWith('2026-08-21', 25);
      expect(settings['gmailbrief.catchupTried']).toBe('2026-08-22');
    } finally {
      svc.onModuleDestroy();
    }
  });

  it('a try-marker already at the cap stops the pass even if the done marker was lost', async () => {
    const { svc, google } = make({ hm: '21:05', settings: { 'gmailbrief.earlyTry': '2026-08-22:3:1787400000' } });
    await svc.briefTick();
    expect(google.gmailImportantForDay).not.toHaveBeenCalled();
  });

  it('a tick that arrives while a pass is still running does nothing — no second read, no second push', async () => {
    const { svc, google, llm } = make({ hm: '21:05', important: [mail('1')] });
    let release: (v: any) => void = () => undefined;
    (llm.completeWithModel as jest.Mock).mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = svc.briefTick();
    await new Promise((r) => setTimeout(r, 5));
    await svc.briefTick(); // overlapping tick
    expect(google.gmailImportantForDay).toHaveBeenCalledTimes(1);
    release({ text: '{"overview":"ok","sections":[]}', model: 'm' });
    await first;
  });
});
