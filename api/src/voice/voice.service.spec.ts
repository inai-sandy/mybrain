import { VoiceService, VoiceTranscribeError, VoiceTransportError, OPENAI_STT_MODEL, utterancesToLines, OPENAI_MAX_UPLOAD_BYTES } from './voice.service';

function make(opts: { keys?: Record<string, any>; settings?: Record<string, string>; clean?: string; contacts?: { name: string }[]; openaiStatus?: number } = {}) {
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
  // Cleanup runs on the named helper 'voice-cleanup' (BEA-1624); the harness answers the model the
  // way LlmService would — default terra, or whatever `voice.cleanup.model` holds.
  const llm: any = {
    completeHelper: jest.fn(async () => opts.clean ?? null),
    helperModel: jest.fn(async (key: string) => {
      if (key !== 'voice-cleanup') return null;
      try { const v = JSON.parse(settings['voice.cleanup.model'] || ''); if (v?.provider && v?.model) return v; } catch { /* default */ }
      return { provider: 'openrouter', model: 'openai/gpt-5.6-terra' };
    }),
    setHelperModel: jest.fn(async (_key: string, model: string) => {
      settings['voice.cleanup.model'] = model ? JSON.stringify({ provider: 'openrouter', model }) : '';
    }),
  };
  const prompts: any = { get: async () => '[cleanup instruction]' };
  const calls: string[] = [];
  const models: string[] = []; // every OpenAI STT model actually asked for (BEA-1625)
  (global as any).fetch = jest.fn(async (url: string, init?: any) => {
    calls.push(url);
    if (url.includes('api.openai.com/v1/audio')) {
      try { models.push(String(init?.body?.get?.('model') ?? '')); } catch { /* body shape varies */ }
      if (opts.openaiStatus && opts.openaiStatus >= 400) {
        return { ok: false, status: opts.openaiStatus, text: async () => 'refused', json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ text: 'um hello world' }) };
    }
    if (url.includes('api.elevenlabs.io')) return { ok: true, json: async () => ({ text: 'eleven labs text' }) };
    if (url.includes('api.deepgram.com')) return { ok: false, json: async () => ({}) }; // simulate no/failed deepgram
    return { ok: false, json: async () => ({}) };
  });
  return { svc: new VoiceService(prisma, connectors, llm, prompts), settings, llm, calls, models };
}

describe('VoiceService', () => {
  it('defaults to the OpenAI engine and transcribes + cleans up', async () => {
    const { svc, llm } = make({ clean: 'Hello world.' });
    const text = await svc.transcribe(Buffer.from('audio'), 'a.webm', 'audio/webm');
    expect(text).toBe('Hello world.');
    expect(llm.completeHelper).toHaveBeenCalled(); // cleanup ran
    // …on the NAMED helper, never on a model id written in this service (BEA-1624).
    expect(llm.completeHelper.mock.calls[0][0]).toBe('voice-cleanup');
    expect(llm.completeHelper.mock.calls[0][3]).toBe('voice-cleanup'); // the usage-log label
  });

  it('returns the raw transcript when cleanup is off', async () => {
    const { svc, llm } = make({ settings: { 'voice.cleanup': '0' } });
    const text = await svc.transcribe(Buffer.from('audio'), 'a.webm');
    expect(text).toBe('um hello world');
    expect(llm.completeHelper).not.toHaveBeenCalled();
  });

  describe('the cleanup model is a setting (BEA-1624)', () => {
    it('defaults to gpt-5.6-terra and offers the curated list', async () => {
      const cfg: any = await make().svc.config();
      expect(cfg.cleanupModel).toBe('openai/gpt-5.6-terra');
      expect(cfg.cleanupModels).toContain('openai/gpt-5.6-terra');
      expect(cfg.cleanupModels).toContain('anthropic/claude-sonnet-5');
    });

    it('saves a curated model through the helper road and reads it back', async () => {
      const { svc, llm, settings } = make();
      expect(await svc.setCleanupModel('anthropic/claude-sonnet-5')).toEqual({ model: 'anthropic/claude-sonnet-5' });
      expect(llm.setHelperModel).toHaveBeenCalledWith('voice-cleanup', 'anthropic/claude-sonnet-5');
      expect(JSON.parse(settings['voice.cleanup.model']).model).toBe('anthropic/claude-sonnet-5');
      expect((await svc.config() as any).cleanupModel).toBe('anthropic/claude-sonnet-5');
    });

    it('refuses a model outside the curated list, and "" goes back to the default', async () => {
      const { svc, llm } = make();
      await expect(svc.setCleanupModel('vendor/made-up-model')).rejects.toThrow(/Unknown model/);
      expect(llm.setHelperModel).not.toHaveBeenCalled();
      expect(await svc.setCleanupModel('')).toEqual({ model: 'openai/gpt-5.6-terra' });
    });

    it('a blank or unreadable row falls back to the default — never to a cheaper model', async () => {
      for (const junk of ['', 'haiku', '{"provider":"openrouter"}', 'not json']) {
        const { svc } = make({ settings: { 'voice.cleanup.model': junk } });
        const m = (await svc.config() as any).cleanupModel;
        expect(m).toBe('openai/gpt-5.6-terra');
        expect(m).not.toMatch(/haiku/);
      }
    });
  });

  it('falls back to OpenAI when the chosen engine fails', async () => {
    // chosen engine = deepgram (key present) but the API fails → falls back to OpenAI
    const { svc } = make({ settings: { 'voice.engine': 'deepgram', 'voice.cleanup': '0' }, keys: { openai: { apiKey: 'oa' }, deepgram: { apiKey: 'dg' } } });
    const text = await svc.transcribe(Buffer.from('audio'), 'a.webm');
    expect(text).toBe('um hello world'); // OpenAI fallback result
  });

  // BEA-1218's two fallback tests were REMOVED by BEA-1625: there is no chain and no latch to
  // test any more. What replaces them is the promise that the usage log still names what ran.
  it('logs the one model that ran (BEA-1625)', async () => {
    const { svc } = make({ settings: { 'voice.cleanup': '0' } });
    const logged: any[] = [];
    (svc as any).prisma.usageLog = { create: async ({ data }: any) => { logged.push(data); return {}; } };
    await svc.transcribe(Buffer.from('x'), 'a.webm', 'audio/webm');
    expect(logged[0].model).toBe(OPENAI_STT_MODEL);
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

// ---- BEA-1625: one model, no fallback chain, and a refusal is never silent ----
describe('VoiceService — gpt-transcribe only', () => {
  it('asks OpenAI for gpt-transcribe and for no other model', async () => {
    const { svc, models } = make({ settings: { 'voice.cleanup': '0' } });
    await svc.transcribe(Buffer.from('audio'), 'a.webm', 'audio/webm');
    expect(models).toEqual([OPENAI_STT_MODEL]);
    expect(models).not.toContain('gpt-4o-transcribe');
    expect(models).not.toContain('whisper-1');
  });

  it('never falls back to an older model when OpenAI refuses', async () => {
    const { svc, models } = make({ settings: { 'voice.cleanup': '0' }, openaiStatus: 400 });
    await expect(svc.transcribe(Buffer.from('audio'), 'a.webm', 'audio/webm')).rejects.toBeInstanceOf(VoiceTranscribeError);
    expect(models).toEqual([OPENAI_STT_MODEL]); // one attempt, one model — no chain behind it
  });

  it('says why it failed instead of answering an empty transcript', async () => {
    const { svc } = make({ settings: { 'voice.cleanup': '0' }, openaiStatus: 500 });
    await expect(svc.transcribe(Buffer.from('audio'), 'a.webm', 'audio/webm')).rejects.toThrow(/could not transcribe/i);
  });

  it('has no disable latch — a refusal does not stop the next attempt trying again', async () => {
    const { svc, models } = make({ settings: { 'voice.cleanup': '0' }, openaiStatus: 403 });
    await expect(svc.transcribe(Buffer.from('a'), 'a.webm', 'audio/webm')).rejects.toBeInstanceOf(VoiceTranscribeError);
    await expect(svc.transcribe(Buffer.from('b'), 'b.webm', 'audio/webm')).rejects.toBeInstanceOf(VoiceTranscribeError);
    expect(models).toEqual([OPENAI_STT_MODEL, OPENAI_STT_MODEL]); // tried again, not latched off
  });

  it('says so plainly when no OpenAI key is connected', async () => {
    const { svc } = make({ keys: {}, settings: { 'voice.cleanup': '0' } });
    await expect(svc.transcribe(Buffer.from('audio'), 'a.webm', 'audio/webm')).rejects.toThrow(/No OpenAI key/i);
  });
});

/* 2026-09-11 meeting-road review: the labeller's ladder. A meeting is the one take with a retry loop
   behind it, so "could not reach the provider" must THROW and "heard nothing" must be ''. */
describe('transcribeMeeting — the ladder', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const dg = (body: any, ok = true, status = 200) => ({ ok, status, json: async () => body });
  const utt = (speaker: number, transcript: string) => ({ speaker, transcript });

  it('labels come back as Speaker N lines, same speaker merged', async () => {
    const { svc } = make({ keys: { deepgram: { apiKey: 'dg' }, openai: { apiKey: 'oa' } } });
    global.fetch = jest.fn(async (url: string) => dg({ results: { utterances: [utt(0, 'hello'), utt(0, 'there'), utt(1, 'hi')] } })) as any;
    expect(await svc.transcribeMeeting(Buffer.from('wav'))).toBe('Speaker 1: hello there\nSpeaker 2: hi');
    expect((global.fetch as any).mock.calls[0][0]).toContain('diarize=true');
    expect((global.fetch as any).mock.calls[0][1].signal).toBeDefined();          // the timeout is on the call
  });
  it('the provider answered and heard nothing → an empty string, not a failure', async () => {
    const { svc } = make({ keys: { deepgram: { apiKey: 'dg' }, openai: { apiKey: 'oa' } } });
    global.fetch = jest.fn(async () => dg({ results: { utterances: [], channels: [{ alternatives: [{ transcript: '' }] }] } })) as any;
    expect(await svc.transcribeMeeting(Buffer.from('wav'))).toBe('');
  });
  it('diarize fails → plain Deepgram text without labels', async () => {
    const { svc } = make({ keys: { deepgram: { apiKey: 'dg' }, openai: { apiKey: 'oa' } } });
    let n = 0;
    global.fetch = jest.fn(async () => (++n === 1 ? dg({}, false, 503) : dg({ results: { channels: [{ alternatives: [{ transcript: 'plain words' }] }] } }))) as any;
    expect(await svc.transcribeMeeting(Buffer.from('wav'))).toBe('plain words');
    expect(n).toBe(2);
  });
  it('both Deepgram legs fail on a file over the OpenAI limit → THROWS a transport error (the retry loop runs)', async () => {
    const { svc } = make({ keys: { deepgram: { apiKey: 'dg' }, openai: { apiKey: 'oa' } } });
    global.fetch = jest.fn(async () => dg({}, false, 500)) as any;
    const big = Buffer.alloc(OPENAI_MAX_UPLOAD_BYTES + 1);
    await expect(svc.transcribeMeeting(big)).rejects.toBeInstanceOf(VoiceTransportError);
    expect((global.fetch as any).mock.calls.length).toBe(2);                     // OpenAI was never tried
  });
  it('a timeout is a transport error, said in minutes', async () => {
    const { svc } = make({ keys: { deepgram: { apiKey: 'dg' } } });
    global.fetch = jest.fn(async () => { const e: any = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }) as any;
    await expect(svc.transcribeMeeting(Buffer.alloc(OPENAI_MAX_UPLOAD_BYTES + 1))).rejects.toThrow(/no answer in 15 min/);
  });
  it('utterancesToLines is pure and starts at Speaker 1', () => {
    expect(utterancesToLines([utt(2, 'a'), utt(2, 'b'), { transcript: '   ' }, utt(0, 'c')])).toEqual(['Speaker 3: a b', 'Speaker 1: c']);
    expect(utterancesToLines([])).toEqual([]);
  });
});
