import { GmailBriefService } from './gmail-brief.service';

// BEA-803: a midday on-demand brief must not block the nightly full brief + Telegram push.
function make(opts: { hm: string; todayBrief?: any; nightlyDone?: string | null }) {
  const settings: Record<string, string> = {};
  if (opts.nightlyDone) settings['gmailbrief.nightlyDone'] = opts.nightlyDone;
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (where.key in settings ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => { settings[where.key] = update?.value ?? create?.value; return {}; },
    },
    gmailBrief: { findUnique: async ({ where }: any) => (where.day === '2026-07-02' ? (opts.todayBrief ?? null) : null) },
  };
  const google: any = { status: async () => ({ connected: true }) };
  const svc = new GmailBriefService(prisma, {} as any, google, {} as any, {} as any, { get: async () => '' } as any);
  jest.spyOn(svc as any, 'tz').mockResolvedValue('Asia/Kolkata');
  jest.spyOn(svc as any, 'dayKey').mockReturnValue('2026-07-02');
  jest.spyOn(svc as any, 'localHM').mockReturnValue(opts.hm);
  jest.spyOn(svc as any, 'finalizeRecentBriefs').mockResolvedValue(undefined);
  const gen = jest.spyOn(svc, 'generate').mockResolvedValue({} as any);
  return { svc, gen, settings };
}

describe('GmailBriefService.briefTick — nightly refresh (BEA-803)', () => {
  it('nightly regenerates (force) and pushes even when a midday brief already exists', async () => {
    const { svc, gen, settings } = make({ hm: '23:59', todayBrief: { day: '2026-07-02', overview: 'partial' } });
    await svc.briefTick();
    expect(gen).toHaveBeenCalledWith('2026-07-02', true, true); // force rebuild + push
    expect(settings['gmailbrief.nightlyDone']).toBe('2026-07-02'); // marker set
  });

  it('does not rebuild/re-push once the nightly marker is set for today', async () => {
    const { svc, gen } = make({ hm: '23:59', todayBrief: { day: '2026-07-02' }, nightlyDone: '2026-07-02' });
    await svc.briefTick();
    expect(gen).not.toHaveBeenCalled();
  });
});
