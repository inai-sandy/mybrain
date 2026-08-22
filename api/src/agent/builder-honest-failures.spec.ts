import { Logger } from '@nestjs/common';
import { AgentAreasService } from './agent-areas.service';
import { PromptsService } from '../prompts/prompts.service';
import { TokenBudgetError } from '../llm/token-budget.service';
import { AMBIGUOUS_TEXT, RULES_TEXT, THINKING_FAILED_TEXT, TROUBLE_TEXT, looksCutOff, proseOf, readTurn } from './thinking-builder';
import type { ToolKnowledge } from '../tools/tool-knowledge.service';

/**
 * BEA-1402 — the builder says what actually went wrong instead of shrugging.
 *
 * What happened live on 2026-08-22: the owner asked the builder about WhatsApp templates, a sample
 * ran fine ("🔎 I tried WhatsApp · List Templates — 25 templates … 0 credits") and the turn answered
 * "I couldn't work that out — try saying it another way." Twice, on two different messages.
 *
 * The cause is in the usage log, not in the tools: BOTH failing turns came back with EXACTLY 8,000
 * completion tokens — `TURN_MAX_TOKENS`, the output ceiling — while the turns either side of them
 * used 726 and 4,352. The model ran past the ceiling, its answer stopped mid-way, nothing could be
 * parsed out of it, and every road out of that fell into one shrug that named nothing and logged
 * nothing. These lock the four honest answers, the one re-ask that rescues the turn, and the rule
 * that "try saying it another way" is now ONLY for a genuinely ambiguous message.
 */

// The owner's two exact messages.
const MSG_1 = 'WhatsApp tools are up and ready. Can you check it and create a template?';
const MSG_2 = 'Now you can create a template using the WhatsApp tool';

const card = (over: Partial<ToolKnowledge> & { actionId: string; name: string }): ToolKnowledge => ({
  service: over.actionId.split(':')[1].split('.')[0],
  provider: 'services',
  params: [],
  fields: [],
  hasDateField: false,
  paging: { how: 'none', source: 'none' },
  cost: { source: 'unknown' },
  health: { ok: true, known: false, successesLast24h: 0, failuresLast24h: 0, emptyLast24h: 0, callsLast30d: 0 },
  notes: [],
  updatedAt: '2026-08-22T00:00:00.000Z',
  ...over,
});

const LIST_TEMPLATES = card({
  actionId: 'svc:whatsapp.list_templates', name: 'WhatsApp · List Templates',
  description: 'Every message template on the gateway, with its status at Meta',
  fields: [{ path: 'templates[].name', kind: 'text', seen: true }, { path: 'templates[].createdAt', kind: 'date', seen: true }],
  hasDateField: true,
  cost: { free: true, note: 'No metered cost.', source: 'provider' },
});
const CREATE_TEMPLATE = card({
  actionId: 'svc:whatsapp.create_template', name: 'WhatsApp · Create Template',
  description: 'Submit a new message template to Meta for approval',
  cost: { free: true, note: 'No metered cost.', source: 'provider' },
});
const CARDS = [LIST_TEMPLATES, CREATE_TEMPLATE];

/** A model answer that stopped mid-way at the output ceiling — no readable `reply` in it at all. */
const CUT_OFF_LEAD = 'Looking at your 25 templates I can see what shape a new one needs to take.';
const CUT_OFF_ANSWER = `${CUT_OFF_LEAD}
{
 "goal": "a nightly WhatsApp email summary that still arrives outside the 24-hour window",
 "sample": null,
 "plan": {"name":"Nightly email summary","sources":[{"kind":"source","actionId":"svc:whatsapp.list_templates","args":{"q":"mybrain_agent_`;
/** The same failure with nothing but half-written JSON in it — there are no words to fall back on. */
const CUT_OFF_SILENT = '{"goal":"a nightly summary","plan":{"name":"Nightly email summary","sources":[{"kind":"source","actionId":"svc:whatsapp.list_templates","args":{"q":"mybrain_agent_';

type Answer = (prompt: string, call: number) => any;

function harness(opts: { answer: Answer; state?: any; sampler?: (settings: Map<string, string>) => any }) {
  const settings = new Map<string, string>();
  if (opts.state) settings.set('agent.builder', JSON.stringify(opts.state));
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      upsert: async ({ where, create, update }: any) => { settings.set(where.key, update?.value ?? create?.value); return {}; },
    },
    agentArea: { findUnique: async () => ({ id: 'ar1', name: 'A', tools: '[]' }) },
    agent: { findMany: async () => [] },
  };
  const agentSvc: any = { createAgent: async () => ({ id: 'job1', areaId: 'ar1', name: 'x' }), updateAgent: async () => ({}) };
  const prompts: string[] = [];
  const llm: any = {
    completeHelper: jest.fn(async (_key: string, prompt: string) => {
      prompts.push(prompt);
      const a = opts.answer(prompt, prompts.length);
      return a === null || a === undefined || typeof a === 'string' ? a : JSON.stringify(a);
    }),
  };
  const promptsSvc = { get: async (k: any) => new PromptsService(prisma).get(k) };
  const tools = CARDS.map((c) => ({ id: c.actionId, name: c.name, group: 'Social', description: c.description || '', connected: true, kind: 'service', service: c.service }));
  const catalog: any = { catalog: async () => ({ groups: [], tools }) };
  const knowledge: any = { lookup: async (ids: string[]) => ids.map((id) => CARDS.find((c) => c.actionId === id)).filter(Boolean) };
  const svc = new AgentAreasService(prisma, agentSvc, llm, promptsSvc as any, catalog, opts.sampler ? opts.sampler(settings) : undefined, knowledge);
  return { svc, prompts, llm, settings, state: () => JSON.parse(settings.get('agent.builder') || '{}') };
}

/** The sampler as it behaved live: 25 templates back, 0 credits, and its 🔎 line into the same row. */
function templateSampler(settings: Map<string, string>) {
  return {
    sample: jest.fn(async (_key: string, actionId: string, args: any) => {
      const row = JSON.parse(settings.get('agent.builder') || '{"log":[]}');
      row.log = [...(row.log || []), { who: 'ai', kind: 'sample', actionId, ok: true, text: '🔎 I tried WhatsApp · List Templates — 25 templates · fields: id, name, language, category, headerType, bodyText… · has a date field (createdAt) · 0 credits', at: new Date().toISOString() }];
      row.samples = { used: 1, credits: 0 };
      settings.set('agent.builder', JSON.stringify(row));
      return { ok: true, actionId, name: 'WhatsApp · List Templates', args, count: 25, listKey: 'templates', fields: [{ path: 'name', kind: 'text' }, { path: 'createdAt', kind: 'date' }], hasDate: true, items: [{ name: 'mybrain_agent_question_v1' }], credits: 0, ms: 900, budget: { used: 1, calls: 3, credits: 0, maxCredits: 5 } };
    }),
  };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ---- (1) the owner's two exact messages -----------------------------------------------------------

describe("the owner's two exact messages (BEA-1402)", () => {
  it('"…check it and create a template?" — a sample, then a cut-off answer: the re-ask rescues the turn', async () => {
    const h = harness({
      sampler: templateSampler,
      answer: (prompt, call) => {
        if (call === 1) return { sample: { actionId: 'svc:whatsapp.list_templates', args: {} } };
        if (call === 2) return CUT_OFF_ANSWER; // the live failure: 8,000 tokens, cut mid-way
        // The one re-ask asks for the shape again, shorter — and this time it lands.
        expect(prompt).toContain('Your last answer could not be read');
        return { reply: 'Creating the template is a one-off, not something to schedule, so I cannot run it from this chat — a sample only ever reads. Do it in Chat (it runs the same WhatsApp tools and asks you to confirm anything that cannot be undone), or on the Tools page. Tell me the wording and I will write out exactly what to create. The nightly agent itself is ready either way.', plan: null };
      },
    });
    const out = await h.svc.builderChat(MSG_1);
    expect(out.reply).not.toContain(AMBIGUOUS_TEXT);
    expect(out.reply).toContain('one-off');
    expect(h.llm.completeHelper).toHaveBeenCalledTimes(3); // ask · cut off · ONE re-ask
  });

  it('"Now you can create a template using the WhatsApp tool" — cut off twice: he is told it was cut off, never a shrug', async () => {
    const h = harness({ answer: () => CUT_OFF_ANSWER });
    const out = await h.svc.builderChat(MSG_2);
    expect(out.reply).not.toContain(AMBIGUOUS_TEXT);
    // The words the model DID write reach him, with the reason there is no more of them.
    expect(out.reply).toContain(CUT_OFF_LEAD);
    expect(out.reply).toMatch(/ran past its length limit and stopped mid-way/);
    expect(h.llm.completeHelper).toHaveBeenCalledTimes(2); // the answer + exactly ONE re-ask
    // The owner's line and the honest answer are both in the conversation.
    const log = h.state().log;
    expect(log[log.length - 2].text).toBe(MSG_2);
    expect(log[log.length - 1].text).toBe(out.reply);
  });

  it('the cause reaches the log with the prompt, the session, the turn and the spend', async () => {
    const errors: string[] = [];
    (Logger.prototype.error as any).mockImplementation((m: any) => { errors.push(String(m)); });
    const h = harness({ answer: () => CUT_OFF_ANSWER });
    await h.svc.builderChat(MSG_1);
    expect(errors.join('\n')).toMatch(/cut-off/);
    expect(errors.join('\n')).toMatch(/prompt agent\.builder/);
    expect(errors.join('\n')).toMatch(/session new-agent/);
    expect(errors.join('\n')).toMatch(/turn 1/);
    expect(errors.join('\n')).toMatch(/tokens spent/);
  });
});

// ---- (2) one honest message per thing that can go wrong -------------------------------------------

describe('the four honest failures (BEA-1402)', () => {
  it('the AI service answered nothing → it says so, and does NOT pay for a second call', async () => {
    const h = harness({ answer: () => null });
    const out = await h.svc.builderChat('every morning, summarise my mail');
    expect(out.reply).toBe(TROUBLE_TEXT['no-answer']);
    expect(h.llm.completeHelper).toHaveBeenCalledTimes(1);
  });

  it('the answer was cut off with no words in it → the plain "stopped mid-way" sentence', async () => {
    const h = harness({ answer: () => CUT_OFF_SILENT });
    const out = await h.svc.builderChat('every morning, summarise my mail');
    expect(out.reply).toBe(TROUBLE_TEXT['cut-off']);
    expect(out.reply).not.toContain(AMBIGUOUS_TEXT);
  });

  it('the answer was cut off but wrote him something first → he reads those words, and why they stop', async () => {
    const h = harness({ answer: () => CUT_OFF_ANSWER });
    const out = await h.svc.builderChat('every morning, summarise my mail');
    expect(out.reply).toContain(CUT_OFF_LEAD);
    expect(out.reply).toMatch(/ran past its length limit/);
  });

  it('the answer could not be read → the owner still gets the words the model wrote him', async () => {
    const prose = 'I can see 25 templates on your gateway. A template needs one blank for the whole summary, because the wording has to stay fixed. Tell me the name you want and I will write it out.';
    const h = harness({ answer: () => prose });
    const out = await h.svc.builderChat('now create the template');
    expect(out.reply).toContain('A template needs one blank');
    expect(out.reply).toContain('outside the shape I expect');
    expect(out.reply).not.toContain(AMBIGUOUS_TEXT);
  });

  it('an unreadable answer with no real words in it → the plain "shape I could not read" sentence', async () => {
    const h = harness({ answer: () => '...' });
    const out = await h.svc.builderChat('now create the template');
    expect(out.reply).toBe(TROUBLE_TEXT.unreadable);
  });

  it('the turn threw → the owner is told the service failed, and the cause + stack reach the log', async () => {
    const errors: any[][] = [];
    (Logger.prototype.error as any).mockImplementation((...a: any[]) => { errors.push(a); });
    const h = harness({ answer: () => { throw new Error('openrouter socket hang up'); } });
    const out = await h.svc.builderChat('every morning, summarise my mail');
    expect(out.reply).toBe(THINKING_FAILED_TEXT);
    expect(String(errors[0][0])).toContain('openrouter socket hang up');
    expect(String(errors[0][0])).toContain('prompt agent.builder');
    expect(errors[0][1]).toBeTruthy(); // the stack
  });

  it("the day's AI budget is gone → the budget's own words, unchanged (BEA-1373)", async () => {
    const h = harness({ answer: () => { throw new TokenBudgetError('the daily AI budget is used up'); } });
    const out = await h.svc.builderChat('every morning, summarise my mail');
    expect(out.reply).toBe('I have stopped for now — the daily AI budget is used up');
  });

  it('"try saying it another way" is now ONLY for a message the model really could not read', async () => {
    const h = harness({ answer: () => ({ reply: '', plan: null }) });
    const out = await h.svc.builderChat('hmm');
    expect(out.reply).toBe(AMBIGUOUS_TEXT);
  });

  it('a good turn is untouched — no extra call, no note', async () => {
    const h = harness({ answer: () => ({ reply: 'What time should it run?', plan: null }) });
    const out = await h.svc.builderChat('summarise my mail every night');
    expect(out.reply).toBe('What time should it run?');
    expect(h.llm.completeHelper).toHaveBeenCalledTimes(1);
  });
});

// ---- (3) a one-off action is said plainly, not shrugged at ----------------------------------------

describe('a one-off action is not an agent, and the builder says so (BEA-1402)', () => {
  it('the rules tell it to say so, where it IS done, and never to deny a tool the facts list', () => {
    expect(RULES_TEXT).toContain('ONE-OFF ACTION');
    expect(RULES_TEXT).toContain('create a WhatsApp template');
    expect(RULES_TEXT).toMatch(/Chat runs these same tools/);
    expect(RULES_TEXT).toMatch(/never say a tool does not exist when the facts above list it/);
  });

  it('the create-template action is in the facts the turn is built on, so it cannot be denied', async () => {
    const h = harness({ answer: () => ({ reply: 'Creating the template is a one-off — do it in Chat.', plan: null }) });
    await h.svc.builderChat(MSG_1);
    expect(h.prompts[0]).toContain('svc:whatsapp.create_template');
    expect(h.prompts[0]).toContain('ONE-OFF ACTION');
  });
});

// ---- (4) reading one model answer -----------------------------------------------------------------

describe('reading a model answer (BEA-1402)', () => {
  it('tells the four kinds apart', () => {
    expect(readTurn(null).trouble).toBe('no-answer');
    expect(readTurn('   ').trouble).toBe('no-answer');
    expect(readTurn(JSON.stringify({ reply: 'hi' })).trouble).toBe('none');
    expect(readTurn(CUT_OFF_ANSWER).trouble).toBe('cut-off');
    expect(readTurn(CUT_OFF_ANSWER).g).toBeNull();
    expect(readTurn('I think we should talk about templates.').trouble).toBe('unreadable');
    // An object we had to close ourselves is a cut-off turn too, even though it parses.
    expect(readTurn('{"reply":"hi","plan":{"name":"x"').trouble).toBe('cut-off');
    // A reply rescued out of a half-written answer is still a cut-off turn — but it IS usable.
    const half = readTurn('{"reply":"Here is what I would do, in ord');
    expect(half.trouble).toBe('cut-off');
    expect(half.g.reply).toContain('Here is what I would do');
  });

  it('knows a stopped-mid-way answer from prose that simply is not JSON', () => {
    expect(looksCutOff('{"a":1}')).toBe(false);
    expect(looksCutOff('{"a":[1,2]')).toBe(true);
    expect(looksCutOff('{"a":"unclosed')).toBe(true);
    expect(looksCutOff('no json here at all')).toBe(false);
    // A template body full of {{1}} placeholders is not an unclosed object.
    expect(looksCutOff('Your body would read: Hello {{1}}, here is your summary.')).toBe(false);
  });

  it('keeps the plain words out of a shape-less answer, fences and half-JSON dropped', () => {
    expect(proseOf('```json\nsome words first\n{"reply":"x"')).toBe('some words first');
    // A template body quoted in prose is not the start of JSON (review fix, BEA-1402).
    expect(proseOf('Your body would read: Hello {{1}}, here is your summary.')).toContain('{{1}}');
    expect(proseOf('a'.repeat(5000)).length).toBeLessThanOrEqual(1200);
  });
});
