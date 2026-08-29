import { KEEP_AS_FETCHED, SocialAgentRunService } from './social-agent-run.service';
import { HISTORY_MANY, askArgs, historyShowsMany, recordedItemCount, sameAsk } from './run-doubt';
import { KNOWLEDGE_NOTES, notesFor } from '../tools/knowledge-notes';
import { RULES_TEXT } from '../agent/thinking-builder';

/**
 * BEA-1403 — the plan road says so LOUDLY when a run is obviously wrong.
 *
 * The evidence these tests replay is the owner's own, from the issue: "Nightly Important Email
 * Summary" ran `svc:gmail.fetch_emails` with `{"query":"newer_than:1d -category:promotions
 * -category:social","user_id":"me"}` — NO `max_results` — and Gmail answered exactly ONE message.
 * The same query answered 6 with `max_results: 25` and 14 with `max_results: 500`. The run said
 * done, twice, and WhatsApped him a clean success.
 *
 * Three locks:
 *  (i)  1 item where this job's OWN ToolCall history shows many for the same ask → said loudly on
 *       the run AND carried into the owner's WhatsApp — never a false all-clear;
 *  (ii) shaping keeps 0 rows out of a non-empty fetch → the run FAILS with the BEA-1377 wording;
 *  (iii) a genuinely empty day is UNTOUCHED — the BEA-1359 rule (honest empties finish done).
 */

// ---- the real recorded arguments (the issue's evidence table) --------------------------------------

const AGENT_ARGS = { query: 'newer_than:1d -category:promotions -category:social', user_id: 'me' };
const FIXED_ARGS = { query: 'newer_than:1d -category:promotions -category:social', user_id: 'me', verbose: true, max_results: 50 };
const CAPPED_ARGS = { query: 'newer_than:1d -category:promotions -category:social', user_id: 'me', verbose: false, max_results: 25 };

/** One message in Gmail's real answer shape (the recorded 2026-08-22 row — the Google sign-in notice). */
const gmailMessage = (id: string, text: string) => ({
  attachmentList: [],
  labelIds: ['UNREAD', 'CATEGORY_UPDATES', 'INBOX'],
  messageId: id,
  messageText: text,
  messageTimestamp: '2026-08-22T16:50:00.000Z',
  sender: 'no-reply@accounts.google.com',
  subject: `Subject of ${id}`,
  threadId: `thread-${id}`,
});

/** The agent's own answer: ONE message — a new-sign-in notice standing in for a whole day of mail. */
const ONE_MESSAGE = {
  messages: [gmailMessage('1a029473f72ebe25', '[image: Google]\r\nA new sign-in on Mac OS\r\n\r\nWe noticed a new sign-in to your Google Account on a Mac OS device. If this was you, you don’t need to do anything. If not, we’ll help you secure your account.')],
};

/** The same query with max_results: 25 answered SIX messages (the issue's table). */
const SIX_MESSAGES = {
  messages: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((id) => gmailMessage(id, `Body of ${id} — a real work mail with enough text that six of these do not fit inside the recorder’s two thousand characters.`)),
};

/** Exactly what the flight recorder keeps of an answer: pretty JSON, cut at 2,000 characters. */
const recorded = (data: any) => JSON.stringify(data, null, 2).slice(0, 2000);

// ---- the pure parts --------------------------------------------------------------------------------

describe('run-doubt — the same ask, read from recorded rows', () => {
  it('the ask ignores how-many/which-page/how-fat arguments: the bare call and the max_results/verbose call are ONE ask', () => {
    expect(sameAsk(AGENT_ARGS, FIXED_ARGS)).toBe(true);
    expect(sameAsk(AGENT_ARGS, CAPPED_ARGS)).toBe(true);
    expect(askArgs(FIXED_ARGS)).toEqual(AGENT_ARGS);
    // a different query is a different ask — five hashtags on one action stay five asks
    expect(sameAsk(AGENT_ARGS, { ...AGENT_ARGS, query: 'from:boss' })).toBe(false);
  });

  it('recordedItemCount: whole JSON exact; a truncated big answer is a LOWER bound; a short summary row reads its number; junk is null', () => {
    expect(recordedItemCount(JSON.stringify(ONE_MESSAGE, null, 2))).toBe(1);
    // the recorder cut the 6-message answer at 2,000 chars — it does not parse, but the message
    // starts before the cut still count, and 6 real messages show at least HISTORY_MANY of them
    const cut = recorded(SIX_MESSAGES);
    expect(() => JSON.parse(cut)).toThrow(); // really truncated — the lock is on the truncated road
    expect(recordedItemCount(cut)).toBeGreaterThanOrEqual(HISTORY_MANY);
    // the Google road records a short human summary — its number is the count
    expect(recordedItemCount('6 messages')).toBe(6);
    expect(recordedItemCount('')).toBeNull();
    expect(recordedItemCount('Nothing was returned.')).toBeNull();
  });

  it('historyShowsMany: the job’s own rows with the same ask and many items → the max; no such row → null (a quiet day stays quiet)', () => {
    const rows = [
      { ok: true, arguments: JSON.stringify(AGENT_ARGS), result: recorded(ONE_MESSAGE) }, // the 1-email call itself
      { ok: true, arguments: JSON.stringify(CAPPED_ARGS), result: recorded(SIX_MESSAGES) }, // max_results: 25 → 6
    ];
    const many = historyShowsMany(rows, AGENT_ARGS);
    expect(many).not.toBeNull();
    expect(many!.max).toBeGreaterThanOrEqual(HISTORY_MANY);
    // only 1-item history → nothing to doubt
    expect(historyShowsMany([{ ok: true, arguments: JSON.stringify(AGENT_ARGS), result: recorded(ONE_MESSAGE) }], AGENT_ARGS)).toBeNull();
    // another ask's rows prove nothing about this one
    expect(historyShowsMany([{ ok: true, arguments: JSON.stringify({ ...AGENT_ARGS, query: 'from:boss' }), result: recorded(SIX_MESSAGES) }], AGENT_ARGS)).toBeNull();
    expect(historyShowsMany([], AGENT_ARGS)).toBeNull();
  });
});

// ---- the runner ------------------------------------------------------------------------------------

function harness(opts: { answer: (id: string, args: any) => any; history?: any[]; shapeReply?: string; watches?: any } = { answer: () => null }) {
  const steps: any[] = [];
  const finish: any[] = [];
  const calls: { id: string; ctx: any }[] = [];
  const agent = {
    appendStep: jest.fn(async (_id: string, s: any) => { steps.push(s); }),
    finishRun: jest.fn(async (_id: string, p: any) => { finish.push(p); }),
    attachOutput: jest.fn(async () => undefined),
  };
  const actions = {
    runDetailed: jest.fn(async (id: string, _input: string, ctx: any) => {
      calls.push({ id, ctx });
      return opts.answer(id, ctx.args);
    }),
  };
  const llm = { completeHelper: jest.fn(async () => opts.shapeReply ?? '{"columns":["sender","subject"],"rows":[["a","s"]]}') };
  const documents = { create: jest.fn(async () => ({ id: 'doc1' })) };
  const alerts = { runFinished: jest.fn(async (..._a: any[]) => ({ sent: true, via: 'template' })), runFailed: jest.fn(async (..._a: any[]) => ({ sent: true })) };
  const prisma = { toolCall: { findMany: jest.fn(async (..._a: any[]) => opts.history || []) } };
  // positional, optional deps LAST: push, budget, knowledge, sources left out; prisma is 11th
  const svc = new SocialAgentRunService(agent as any, actions as any, llm as any, documents as any, alerts as any, undefined, undefined, opts.watches, undefined, undefined, prisma as any);
  return { svc, steps, finish, calls, alerts, documents, prisma, llm };
}

const GMAIL = 'svc:gmail.fetch_emails';
const job = (over: any = {}) => ({
  id: 'ag1',
  name: 'Nightly Important Email Summary',
  prompt: KEEP_AS_FETCHED,
  tools: [GMAIL],
  toolArgs: { [GMAIL]: { actionId: GMAIL, args: { ...AGENT_ARGS } } },
  outputDest: 'document',
  sheetId: null,
  notifyWhatsApp: true,
  mode: 'run',
  ...over,
});

const gmailAnswer = (data: any) => ({ ok: true, credits: 0, serviceName: 'Gmail', actionName: 'Fetch Emails', data });

describe('BEA-1403 (i): 1 item against the job’s own history of many → said loudly, and the doubt reaches WhatsApp', () => {
  const history = [
    { ok: true, arguments: JSON.stringify(CAPPED_ARGS), result: recorded(SIX_MESSAGES), createdAt: new Date() },
    { ok: true, arguments: JSON.stringify(FIXED_ARGS), result: recorded(SIX_MESSAGES), createdAt: new Date() },
  ];

  it('the run finishes but the doubt LEADS the result, a ⚠️ step lands on the source node, and the WhatsApp headline carries the doubt — never a clean all-clear', async () => {
    const h = harness({ answer: () => gmailAnswer(ONE_MESSAGE), history });
    await h.svc.run('run1', job());
    expect(h.finish[0].status).toBe('done');
    // the loud step, on the source's own node
    const warn = h.steps.find((s) => /⚠️ Gmail · Fetch Emails returned 1 item, but this job's own recorded calls got \d+ or more for the same ask/.test(s.label));
    expect(warn).toBeTruthy();
    expect(warn.nodeId).toBe(`src:${GMAIL}`);
    expect(warn.label).toMatch(/max_results/); // it says what to check
    // the result text leads with the doubt — the run screen can never read as a clean success
    expect(h.finish[0].resultText.startsWith('⚠️')).toBe(true);
    // the owner's notification carries the doubt
    expect(h.alerts.runFinished).toHaveBeenCalledTimes(1);
    const headline = h.alerts.runFinished.mock.calls[0][1];
    expect(headline).toMatch(/⚠️ check this run — Gmail · Fetch Emails returned 1 item where past runs got \d+\+/);
    // the history read was THIS job's own rows for THIS action — never a global average
    const q = h.prisma.toolCall.findMany.mock.calls[0][0];
    expect(q.where).toMatchObject({ agentId: 'ag1', action: GMAIL, ok: true });
  });

  it('no history of many → no doubt: the same 1-email answer with an empty history is an ordinary run (zero false alarms)', async () => {
    const h = harness({ answer: () => gmailAnswer(ONE_MESSAGE), history: [] });
    await h.svc.run('run1', job());
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).not.toMatch(/⚠️/);
    expect(h.alerts.runFinished.mock.calls[0][1]).not.toMatch(/⚠️/);
    expect(h.steps.some((s) => /returned 1 item/.test(s.label))).toBe(false);
  });

  it('a harness without prisma (every older spec) never doubts and behaves exactly as before', async () => {
    const steps: any[] = [];
    const finish: any[] = [];
    const agent = { appendStep: jest.fn(async (_i: string, s: any) => { steps.push(s); }), finishRun: jest.fn(async (_i: string, p: any) => { finish.push(p); }), attachOutput: jest.fn(async () => undefined) };
    const actions = { runDetailed: jest.fn(async () => gmailAnswer(ONE_MESSAGE)) };
    const llm = { completeHelper: jest.fn() };
    const documents = { create: jest.fn(async () => ({ id: 'doc1' })) };
    const svc = new SocialAgentRunService(agent as any, actions as any, llm as any, documents as any);
    await svc.run('run1', job({ notifyWhatsApp: false }));
    expect(finish[0].status).toBe('done');
    expect(finish[0].resultText).not.toMatch(/⚠️/);
  });
});

describe('BEA-1403 (ii): shaping keeps 0 rows out of a non-empty fetch → the run FAILS with the BEA-1377 wording', () => {
  it('6 real messages in, 0 rows shaped → failed, the exact sentence, nothing written, the failure (not a success) reaches the owner', async () => {
    const h = harness({
      answer: () => gmailAnswer(SIX_MESSAGES),
      shapeReply: '{"columns":["sender","subject"],"rows":[]}',
    });
    await h.svc.run('run1', job({ prompt: 'Keep only the important emails. Columns: sender, subject.' }));
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toBe('fetched 6 answers but recognised 0 rows — this is a My Brain bug, not the vendor');
    const failedStep = h.steps.find((s) => s.status === 'failed' && s.nodeId === 'shape');
    expect(failedStep.label).toBe('fetched 6 answers but recognised 0 rows — this is a My Brain bug, not the vendor');
    expect(h.documents.create).not.toHaveBeenCalled(); // nothing written
    expect(h.alerts.runFailed).toHaveBeenCalled(); // the owner hears the failure, not a clean success
    expect(h.alerts.runFinished).not.toHaveBeenCalled();
  });

  it('the incident’s run 1: ONE message fetched, 0 rows shaped → failed with "fetched 1 answer …", never a done run', async () => {
    const h = harness({ answer: () => gmailAnswer(ONE_MESSAGE), shapeReply: '{"columns":["sender","subject"],"rows":[]}' });
    await h.svc.run('run1', job({ prompt: 'Summarise the important emails. Columns: sender, subject.' }));
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toBe('fetched 1 answer but recognised 0 rows — this is a My Brain bug, not the vendor');
  });

  it('shaping that keeps SOME rows is untouched — 6 in, 1 kept is a fine day', async () => {
    const h = harness({ answer: () => gmailAnswer(SIX_MESSAGES), shapeReply: '{"columns":["sender","subject"],"rows":[["boss","leave request"]]}' });
    await h.svc.run('run1', job({ prompt: 'Keep only the important emails. Columns: sender, subject.' }));
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).toMatch(/\*\*1 row\*\*/);
  });
});

describe('BEA-1403 (iii): a genuinely empty day is NOT a failure — the BEA-1359 rule survives', () => {
  it('a search the vendor answers not_found for still finishes done and honest, with no doubt raised, even when history shows many', async () => {
    const h = harness({
      answer: () => ({ ok: false, notFound: true, credits: 0, error: 'Instagram could not do that: No posts found', serviceName: 'Instagram', actionName: 'Search Hashtag Posts' }),
      history: [{ ok: true, arguments: JSON.stringify({ hashtag: 'smarthomeindia' }), result: recorded({ posts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }) }],
    });
    await h.svc.run('run1', job({
      tools: ['svc:instagram.search_hashtag'],
      toolArgs: { 'svc:instagram.search_hashtag': { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia' } } },
    }));
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).toMatch(/0 posts found — nothing to write/);
    expect(h.finish[0].resultText).not.toMatch(/⚠️/);
    expect(h.steps.some((s) => /returned 1 item/.test(s.label))).toBe(false);
  });
});

describe('BEA-1403: the doubt rides the Watch/Alert road too — never a calm all-clear', () => {
  const IG = 'svc:instagram.user_posts';
  const igItem = { id: 'p1', caption: 'a post', url: 'https://instagram.com/p/p1' };
  const igHistory = [
    { ok: true, arguments: JSON.stringify({ handle: 'acme' }), result: recorded({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }), createdAt: new Date() },
  ];
  const watchJob = () => job({ tools: [IG], toolArgs: { [IG]: { actionId: IG, args: { handle: 'acme' } } }, mode: 'watch', outputDest: 'document' });
  const igAnswer = { ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Posts', data: { items: [igItem] } };

  it('a changed watch: the result leads with the doubt and the WhatsApp summary carries it', async () => {
    const watches = { get: jest.fn(async () => ({ lastResult: { items: [] }, lastAt: new Date() })), save: jest.fn(async () => undefined) };
    const h = harness({ answer: () => igAnswer, history: igHistory, watches });
    await h.svc.run('run1', watchJob());
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText.startsWith('⚠️')).toBe(true);
    expect(h.alerts.runFinished).toHaveBeenCalledTimes(1);
    expect(h.alerts.runFinished.mock.calls[0][1]).toMatch(/^⚠️ check this run — .*returned 1 item where past runs got \d+\+/);
  });

  it('a "nothing changed" watch still says the doubt on the run — the calm sentence never stands alone over a starved source', async () => {
    const watches = { get: jest.fn(async () => ({ lastResult: { items: [igItem] }, lastAt: new Date() })), save: jest.fn(async () => undefined) };
    const h = harness({ answer: () => igAnswer, history: igHistory, watches });
    await h.svc.run('run1', watchJob());
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).toMatch(/Nothing changed/);
    expect(h.finish[0].resultText).toMatch(/⚠️ .*returned 1 item, but this job's own recorded calls/);
  });
});

// ---- the fact card and the builder rule ------------------------------------------------------------

describe('BEA-1403: the trap is written down where the machine reads it', () => {
  it('the svc:gmail.fetch_emails card says the bare default is exactly ONE message and to always pass max_results', () => {
    const notes = notesFor('svc:gmail.fetch_emails', 'gmail', KNOWLEDGE_NOTES).flatMap((n) => n.notes);
    const trap = notes.find((n) => /exactly ONE message/.test(n));
    expect(trap).toBeTruthy();
    expect(trap).toMatch(/max_results/);
    expect(trap).toMatch(/silent data-loss default/);
    expect(trap).toMatch(/page beyond it/i);
  });

  it('the builder’s judgement rules carry the general silent-default rule: set the limit argument explicitly, page for "all"', () => {
    expect(RULES_TEXT).toMatch(/SILENT-DEFAULT trap/);
    expect(RULES_TEXT).toMatch(/max_results \/ limit \/ page_size/);
    expect(RULES_TEXT).toMatch(/exactly ONE message/);
    expect(RULES_TEXT).toMatch(/page beyond that limit/);
  });
});
