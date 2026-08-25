import { toolDocText, toolIndexText, docHash } from './tool-doc';

/**
 * ONE DOCUMENT PER TOOL (BEA-1468).
 *
 * The owner: *"Each tool should have a document… Codex should have full access to all the tools and
 * actions… If the context is not proper, it cannot create the right agent that we are looking for."*
 *
 * That last clause is what these test. Thin context is not a theoretical risk here — it is what his
 * first real build hit: Codex was given an empty tool list and wrote a program that could not find
 * Gmail. So the strongest assertions are that NOTHING is filtered out.
 */

const actions = [
  { id: 'svc:gmail.fetch_emails', name: 'Fetch emails', description: 'Read messages from a mailbox.', method: 'GET' },
  { id: 'svc:gmail.send_email', name: 'Send an email', description: 'Send a message.', risky: true },
  { id: 'svc:gmail.old_search', name: 'Old search', description: 'The previous search.', retired: true },
];

describe('a tool’s document', () => {
  const doc = () => toolDocText({ service: 'gmail', name: 'Gmail', connected: true, actions });

  it('lists EVERY action, and says so', () => {
    const t = doc();
    expect(t).toContain('svc:gmail.fetch_emails');
    expect(t).toContain('svc:gmail.send_email');
    expect(t).toContain('this is the whole list, not a selection');
  });

  it('keeps a retired action, marked — never hides one', () => {
    // The owner's standing rule: do not skip any action from a provider.
    const t = doc();
    expect(t).toContain('svc:gmail.old_search');
    expect(t).toContain('Retired by the vendor');
  });

  it('counts them, so a reader can tell a short list from a truncated one', () => {
    expect(doc()).toContain('**3 actions** (1 retired)');
  });

  it('marks the ones that stop and ask, and says that is not a refusal', () => {
    const t = doc();
    expect(t).toContain('asks first');
    expect(t).toContain('the run pauses, he answers, and it continues');
    expect(t).toContain('Reads are never gated');
  });

  it('says plainly when a tool is NOT connected', () => {
    // Exactly the sentence that would have saved his first build: it needed Notion and WhatsApp,
    // neither was connected, and nothing told Codex until the program had already been written.
    const t = toolDocText({ service: 'notion', name: 'Notion', connected: false, actions: [] });
    expect(t).toContain('**Not connected.**');
    expect(t).toContain('cannot be called until the owner connects it');
  });

  it('puts the exact id first on every line — the id is what a program needs', () => {
    expect(doc()).toMatch(/- `svc:gmail\.fetch_emails` — Read messages from a mailbox\./);
  });

  it('tells the reader to get an action’s detail before calling it', () => {
    const t = doc();
    expect(t).toContain('ask for that one action by its id');
    expect(t).toMatch(/guessing a parameter name is the most common way a build\s+produces a program that runs and returns nothing/);
  });

  it('is stable — the same tool hashes the same, a changed one does not', () => {
    expect(docHash(doc())).toBe(docHash(doc()));
    const changed = toolDocText({ service: 'gmail', name: 'Gmail', connected: true, actions: actions.slice(0, 2) });
    expect(docHash(changed)).not.toBe(docHash(doc()));
  });
});

describe('the index of every tool', () => {
  it('names each tool with its action count', () => {
    const t = toolIndexText([{ service: 'gmail', name: 'Gmail', actions: 27 }, { service: 'notion', name: 'Notion', actions: 14 }]);
    expect(t).toContain('`gmail` — Gmail · 27 actions');
    expect(t).toContain('`notion` — Notion · 14 actions');
  });

  it('separates what is NOT connected, and says to speak up rather than work around it', () => {
    const t = toolIndexText([{ service: 'gmail', name: 'Gmail', actions: 27 }, { service: 'notion', name: 'Notion', actions: 0, connected: false }]);
    expect(t).toContain('## Not connected');
    expect(t).toContain('say so rather than working around it');
  });

  it('says so honestly when nothing is connected at all', () => {
    expect(toolIndexText([])).toContain('No tools are connected yet');
  });
});

/**
 * …and both Codex turns must actually POINT at the documents (BEA-1468).
 *
 * Building a knowledge base nobody is told about is the exact failure this week keeps repeating: a
 * capability added on one side, and nothing on the other side that heard about it. It has now cost
 * five live runs. So the prompts are asserted, not assumed.
 */
describe('Codex is told the documents exist', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path');
  const goalPrompt = () => readFileSync(join(__dirname, '../agent/goal.ts'), 'utf8');
  const buildPrompt = () => readFileSync(join(__dirname, '../worker/goal-build.ts'), 'utf8');

  it('the goal turn names all three lookups', () => {
    const t = goalPrompt();
    expect(t).toContain('list_tools');
    expect(t).toContain('tool_doc(service)');
    expect(t).toContain('action_doc(actionId)');
  });

  it('the build turn names them too — one of the two is not enough', () => {
    const t = buildPrompt();
    expect(t).toContain('list_tools');
    expect(t).toContain('tool_doc(service)');
    expect(t).toContain('action_doc(actionId)');
  });

  it('both say WHY, using what actually went wrong', () => {
    for (const t of [goalPrompt(), buildPrompt()]) {
      expect(t).toContain('Look the tools up — do not guess');
      expect(t).toMatch(/wrote a\s*\\?\n?program that could not find Gmail/);
      expect(t).toContain('the documents say so');
    }
  });
});
