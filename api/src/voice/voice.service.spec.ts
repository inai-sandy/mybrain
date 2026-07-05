import { VoiceService } from './voice.service';

function make(opts: { keys?: Record<string, any>; settings?: Record<string, string>; clean?: string; contacts?: { name: string }[] } = {}) {
  const settings: Record<string, string> = { ...(opts.settings || {}) };
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => {
        settings[where.key] = update?.value ?? create.value;
        return { key: where.key, value: settings[where.key] };
      },
    },
    usageLog: { create: async () => ({}) },
    contact: { findMany: async () => opts.contacts ?? [] },
  };
  const keys = opts.keys ?? { openai: { apiKey: 'oa' } };
  const connectors: any = { get: async (n: string) => keys[n] ?? null };
  const llm: any = { completeWith: jest.fn(async () => opts.clean ?? null) };
  const prompts: any = { get: async () => '[cleanup instruction]' };
  const calls: string[] = [];
  (global as any).fetch = jest.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('api.openai.com/v1/audio')) return { ok: true, json: async () => ({ text: 'um hello world' }) };
    if (url.includes('api.elevenlabs.io')) return { ok: true, json: async () => ({ text: 'eleven labs text' }) };
    if (url.includes('api.deepgram.com')) return { ok: false, json: async () => ({}) }; // simulate no/failed deepgram
    return { ok: false, json: async () => ({}) };
  });
  return { svc: new VoiceService(prisma, connectors, llm, prompts), settings, llm, calls };
}

describe('VoiceService', () => {
  it('defaults to the OpenAI engine and transcribes + cleans up', async () => {
    const { svc, llm } = make({ clean: 'Hello world.' });
    const text = await svc.transcribe(Buffer.from('audio'), 'a.webm', 'audio/webm');
    expect(text).toBe('Hello world.');
    expect(llm.completeWith).toHaveBeenCalled(); // cleanup ran
  });

  it('returns the raw transcript when cleanup is off', async () => {
    const { svc, llm } = make({ settings: { 'voice.cleanup': '0' } });
    const text = await svc.transcribe(Buffer.from('audio'), 'a.webm');
    expect(text).toBe('um hello world');
    expect(llm.completeWith).not.toHaveBeenCalled();
  });

  it('falls back to OpenAI when the chosen engine fails', async () => {
    // chosen engine = deepgram (key present) but the API fails → falls back to OpenAI
    const { svc } = make({ settings: { 'voice.engine': 'deepgram', 'voice.cleanup': '0' }, keys: { openai: { apiKey: 'oa' }, deepgram: { apiKey: 'dg' } } });
    const text = await svc.transcribe(Buffer.from('audio'), 'a.webm');
    expect(text).toBe('um hello world'); // OpenAI fallback result
  });

  it('ignores a chatty "reply" from cleanup and keeps the raw transcript', async () => {
    const { svc } = make({ clean: "I don't see any transcript text to clean up. Please provide the speech you'd like cleaned." });
    const text = await svc.transcribe(Buffer.from('audio'), 'a.webm');
    expect(text).toBe('um hello world'); // raw STT kept, not the meta-message
  });

  it('streamToken returns null for a non-Deepgram engine, without calling Deepgram (BEA-888)', async () => {
    const { svc, calls } = make({ settings: { 'voice.engine': 'openai' }, keys: { openai: { apiKey: 'oa' }, deepgram: { apiKey: 'dg' } } });
    expect(await svc.streamToken()).toBeNull();
    expect(calls.some((u) => u.includes('deepgram.com/v1/auth/grant'))).toBe(false);
  });

  it('streamToken attempts the Deepgram grant only when the engine IS Deepgram (BEA-888)', async () => {
    const { svc, calls } = make({ settings: { 'voice.engine': 'deepgram' }, keys: { deepgram: { apiKey: 'dg' } } });
    await svc.streamToken();
    expect(calls.some((u) => u.includes('deepgram.com/v1/auth/grant'))).toBe(true);
  });

  it('reports engines with their configured flags', async () => {
    const { svc } = make({ keys: { openai: { apiKey: 'oa' }, elevenlabs: { apiKey: 'el' } } });
    const cfg = await svc.config();
    const byId = Object.fromEntries(cfg.engines.map((e: any) => [e.id, e.configured]));
    expect(byId.openai).toBe(true);
    expect(byId.elevenlabs).toBe(true);
    expect(byId.deepgram).toBe(false);
    expect(cfg.engine).toBe('openai');
  });
});
