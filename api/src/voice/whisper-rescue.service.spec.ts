import { VoiceService } from './voice.service';

/* whisperRescue() must never make a take worse: every failure returns the FIRST answer (review, 2026-09-10). */
function make(opts: { setting?: string | null; settingThrows?: boolean; key?: string | null; fetchImpl?: any }) {
  const prisma: any = {
    setting: { findUnique: jest.fn(async () => { if (opts.settingThrows) throw new Error('SQLITE_BUSY'); return opts.setting == null ? null : { value: opts.setting }; }) },
    usageLog: { create: jest.fn(async () => undefined) },
    contact: { findMany: jest.fn(async () => []) },
  };
  const connectors: any = { get: jest.fn(async () => (opts.key === null ? null : { apiKey: opts.key ?? 'k' })) };
  const svc = new VoiceService(prisma, connectors, {} as any, {} as any);
  (global as any).fetch = opts.fetchImpl || jest.fn();
  return { svc, prisma, fetch: (global as any).fetch };
}
const buf = Buffer.alloc(16000 * 2 * 20);   // 20 s of 16-bit 16 kHz
const good = { text: Array.from({ length: 40 }, (_, i) => 'w' + i).join(' '), language: 'english', segments: [{ avg_logprob: -0.5 }] };

describe('VoiceService.whisperRescue — failure containment', () => {
  it('keeps the first answer when gpt was plausible (whisper is not even asked)', async () => {
    const { svc, fetch } = make({});
    expect(await svc.whisperRescue(buf, 'a.wav', 'audio/wav', Array(20).fill('w').join(' '), 20)).toContain('w');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('the off switch keeps the first answer', async () => {
    const { svc, fetch } = make({ setting: '0' });
    expect(await svc.whisperRescue(buf, 'a.wav', 'audio/wav', 'It is', 20)).toBe('It is');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('a database error on the setting read keeps the first answer — never a throw', async () => {
    const { svc } = make({ settingThrows: true });
    await expect(svc.whisperRescue(buf, 'a.wav', 'audio/wav', 'It is', 20)).resolves.toBe('It is');
  });
  it('no OpenAI key keeps the first answer', async () => {
    const { svc } = make({ key: null });
    expect(await svc.whisperRescue(buf, 'a.wav', 'audio/wav', 'It is', 20)).toBe('It is');
  });
  it('an HTTP error keeps the first answer', async () => {
    const { svc } = make({ fetchImpl: jest.fn(async () => ({ ok: false, status: 500 })) });
    expect(await svc.whisperRescue(buf, 'a.wav', 'audio/wav', 'It is', 20)).toBe('It is');
  });
  it('bad JSON keeps the first answer', async () => {
    const { svc } = make({ fetchImpl: jest.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })) });
    expect(await svc.whisperRescue(buf, 'a.wav', 'audio/wav', 'It is', 20)).toBe('It is');
  });
  it('a confident whisper answer replaces a near-empty first answer, and is logged as a rescue', async () => {
    const { svc, prisma } = make({ fetchImpl: jest.fn(async () => ({ ok: true, json: async () => good })) });
    const out = await svc.whisperRescue(buf, 'a.wav', 'audio/wav', 'It is', 20);
    expect(out).toBe(good.text);
    expect(prisma.usageLog.create).toHaveBeenCalledWith({ data: { feature: 'voice-rescue', model: 'whisper-1', cost: null } });
  });
  it('an unconfident whisper answer is declined', async () => {
    const { svc } = make({ fetchImpl: jest.fn(async () => ({ ok: true, json: async () => ({ ...good, segments: [{ avg_logprob: -0.95 }] }) })) });
    expect(await svc.whisperRescue(buf, 'a.wav', 'audio/wav', 'It is', 20)).toBe('It is');
  });
});
