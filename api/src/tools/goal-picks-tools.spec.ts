import { goalPrompt, toolsText } from '../agent/goal';

/**
 * The goal writer chooses its own tools (BEA-1543).
 *
 * He was asked, twice: *"Which connected tools should the agent use to create and populate the Google
 * Sheet and send the WhatsApp message?"* — shown under "Codex needs to know". The prompt said so in as
 * many words: *"If the work needs one, ask him which — do not guess."*
 *
 * That line existed for a real reason of his: *"Why do you have to send the full catalog of tools?
 * During the chat discussion I will let you know the tools that we have to send."* The objection was
 * VOLUME — 1,279 actions in a prompt — and it was implemented as "name them or you get asked".
 *
 * Both are honoured now: still not the catalog, but the dozen actions that have actually SUCCEEDED on
 * his account, so Codex can choose without a question and the prompt stays small.
 */
describe('the goal writer does not ask which tool', () => {
  it('no longer tells Codex to ask him which', () => {
    expect(toolsText([])).not.toMatch(/ask him which/i);
  });

  // Reached only when nothing has ever worked — then saying so IS the honest answer, and it must
  // still not hand him a list of ids to pick from.
  it('says plainly when there is genuinely nothing, without asking for ids', () => {
    const t = toolsText([]);
    expect(t).toMatch(/nothing has ever run successfully/i);
    expect(t).toMatch(/do not ask him to pick ids/i);
  });

  it('tells Codex to choose, and to name its choice in plain words', () => {
    const p = goalPrompt({ transcript: [], tools: [{ actionId: 'svc:reddit.subreddit', name: 'Subreddit', card: null, sample: undefined }] } as any);
    expect(p).toMatch(/Choose the tools yourself/);
    expect(p).toMatch(/NEVER ask him which tool/);
    expect(p).toMatch(/say your choice in plain words/);
  });

  it('still tells it to say when nothing can do part of the job', () => {
    const p = goalPrompt({ transcript: [], tools: [] } as any);
    expect(p).toMatch(/say that plainly instead of asking him to choose/);
  });

  // The whole point of his original objection: this must never become "here is the catalog".
  it('keeps the tool section small — it is a shortlist, not a catalog', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ actionId: `svc:x.a${i}`, name: `A${i}`, card: null, sample: undefined }));
    const p = goalPrompt({ transcript: [], tools: many } as any);
    expect((p.match(/svc:x\.a/g) || []).length).toBeLessThanOrEqual(12);
  });
});
