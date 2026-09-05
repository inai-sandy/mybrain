import { readFileSync } from 'fs';
import { join } from 'path';
import { LlmService } from './llm.service';
import { CURATED_MODELS, TERRA_MODEL } from './curated-models';
import { EmoSettingsService, EMO_MODELS } from '../emo/emo-settings.service';
import { modelPrice } from '../usage/pricing';

/**
 * BEA-1624 — dictation cleanup and the EMO router run on the OWNER'S model, as settings.
 *
 * Owner, 2026-09-05: "why are we using Claude Haiku?" → "use gpt-5.6-terra". Both places carried
 * a Haiku id inline — no setting, no picker. Now both are named helpers whose rows are the
 * owner-facing keys (`voice.cleanup.model`, `emo.router.model`), default terra, and a blank or
 * unreadable row falls back to that default — never to a cheaper model.
 */

const TERRA = { provider: 'openrouter', model: TERRA_MODEL };
const HAIKU = /haiku/i;

/** A real LlmService over an in-memory Setting table. */
function harness(rows: Record<string, string> = {}, opts: { openrouterKey?: string; answer?: string } = {}) {
  const settings: Record<string, string> = { ...rows };
  const logged: any[] = [];
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => {
        settings[where.key] = update?.value ?? create.value;
        return { key: where.key, value: settings[where.key] };
      },
    },
    usageLog: { create: async ({ data }: any) => { logged.push(data); return data; } },
  };
  const connectors: any = { get: async (n: string) => (n === 'openrouter' && opts.openrouterKey ? { apiKey: opts.openrouterKey } : null) };
  const llm = new LlmService(connectors, prisma);
  return { llm, settings, logged, prisma };
}

describe('the owner\'s model choice for dictation cleanup and the EMO router (BEA-1624)', () => {
  it('both helpers are registered and default to openai/gpt-5.6-terra', () => {
    expect(LlmService.HELPERS['voice-cleanup']).toEqual(TERRA);
    expect(LlmService.HELPERS['emo-router']).toEqual(TERRA);
  });

  it('with no row saved, both resolve to terra', async () => {
    const { llm } = harness();
    expect(await llm.helperModel('voice-cleanup')).toEqual(TERRA);
    expect(await llm.helperModel('emo-router')).toEqual(TERRA);
  });

  it('their rows are the owner-facing keys, and saving through the helper road writes THOSE rows', async () => {
    expect(LlmService.helperSettingKey('voice-cleanup')).toBe('voice.cleanup.model');
    expect(LlmService.helperSettingKey('emo-router')).toBe('emo.router.model');
    expect(LlmService.helperSettingKey('agent-grade')).toBe('helper.agent-grade.llm'); // everyone else, unchanged
    const { llm, settings } = harness();
    await llm.setHelperModel('voice-cleanup', 'anthropic/claude-sonnet-5');
    expect(JSON.parse(settings['voice.cleanup.model'])).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' });
    expect(settings['helper.voice-cleanup.llm']).toBeUndefined();
  });

  it('a changed setting is honoured — voice', async () => {
    const { llm } = harness({ 'voice.cleanup.model': JSON.stringify({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }) });
    expect((await llm.helperModel('voice-cleanup'))?.model).toBe('anthropic/claude-sonnet-5');
  });

  it('a changed setting is honoured — EMO: the settings screen writes the very row the router reads', async () => {
    const { llm, prisma } = harness();
    const emo = new EmoSettingsService(prisma);
    expect((await emo.get()).routerModel).toBe(TERRA_MODEL); // the screen shows the helper's default
    await emo.set({ routerModel: 'anthropic/claude-sonnet-4.6' });
    expect((await llm.helperModel('emo-router'))?.model).toBe('anthropic/claude-sonnet-4.6');
    expect((await emo.get()).routerModel).toBe('anthropic/claude-sonnet-4.6');
  });

  it.each(['', '   ', 'haiku', 'not json', '{"provider":"openrouter"}', '{"model":""}', '{}'])(
    'a blank or unreadable row (%j) falls back to terra — never to a cheaper model',
    async (junk) => {
      for (const key of ['voice-cleanup', 'emo-router'] as const) {
        const { llm } = harness({ [LlmService.helperSettingKey(key)]: junk });
        const cfg = await llm.helperModel(key);
        expect(cfg).toEqual(TERRA);
        expect(cfg?.model).not.toMatch(HAIKU);
      }
    },
  );

  it('the usage log names the model that ran, under the cleanup\'s own feature label', async () => {
    const { llm, logged } = harness({}, { openrouterKey: 'or-key' });
    const seen: any[] = [];
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hello world.' } }], usage: { prompt_tokens: 40, completion_tokens: 5, cost: 0.0001 } }) };
    });
    const out = await llm.completeHelper('voice-cleanup', 'um hello world', 200, 'voice-cleanup');
    expect(out).toBe('Hello world.');
    expect(seen[0].model).toBe(TERRA_MODEL); // what went over the wire
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ feature: 'voice-cleanup', model: TERRA_MODEL, promptTokens: 40, completionTokens: 5 });
  });

  it('both are interactive: one call, no retry dance while a person or a device waits', async () => {
    expect(LlmService.INTERACTIVE_HELPERS.has('voice-cleanup')).toBe(true);
    expect(LlmService.INTERACTIVE_HELPERS.has('emo-router')).toBe(true);
    const { llm } = harness({}, { openrouterKey: 'or-key' });
    let calls = 0;
    (global as any).fetch = jest.fn(async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) }; });
    expect(await llm.completeHelper('voice-cleanup', 'p', 50, 'voice-cleanup')).toBeNull();
    expect(await llm.completeHelper('emo-router', 'p', 50, 'emo-router')).toBeNull();
    expect(calls).toBe(2);
  });

  it('the picker lists offer terra, and the price table knows it', () => {
    expect(CURATED_MODELS).toContain(TERRA_MODEL);
    expect(EMO_MODELS).toContain(TERRA_MODEL);
    expect(EMO_MODELS).toEqual([...CURATED_MODELS]);
    expect(modelPrice(TERRA_MODEL)).toEqual({ in: 2, out: 12 });
  });

  it('neither service carries a model id of its own any more — the setting is the only road', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
    const voice = src('voice/voice.service.ts');
    const router = src('emo/emo-router.service.ts');
    // The exact bug: `completeWith({ provider:'openrouter', model:'anthropic/claude-haiku-4.5' }…)`.
    expect(voice).not.toMatch(/claude-haiku|completeWith\(/);
    expect(router).not.toMatch(/claude-haiku|completeWith\(|emo\.router\.model'/);
    expect(voice).toMatch(/completeHelper\(\s*'voice-cleanup'/);
    expect(router).toMatch(/completeHelper\(\s*'emo-router'/);
  });

  it('the Voice screen has the picker, wired to the cleanup-model route', () => {
    const settings = readFileSync(join(__dirname, '../../../web/src/pages/Settings.tsx'), 'utf8');
    expect(settings).toContain('/api/voice/cleanup-model');
    expect(settings).toContain('data-testid="voice-cleanup-model"');
    expect(settings).toContain("'openai/gpt-5.6-terra'"); // a readable label for the id
  });
});
