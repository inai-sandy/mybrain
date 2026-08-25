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

  it('marks a gated action as USABLE, not as a warning (BEA-1469)', () => {
    // The first real build read the old tag — "(asks first)" — as a warning, concluded WhatsApp had
    // no "safe matching action", and failed the whole run. The document listed `send_text` right
    // there. A header explaining the gate once cannot outweigh a warning sitting on the very line
    // where the choice gets made.
    const t = doc();
    expect(t).toContain('**he confirms it** — usable');
    expect(t).not.toContain('asks first');
    expect(t).toContain('That is a pause, not a refusal');
    expect(t).toContain('is not a reason to look for an alternative or to leave a step out');
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

  it('both say a confirmed action is still a usable one (BEA-1469)', () => {
    for (const t of [goalPrompt(), buildPrompt()]) {
      expect(t).toContain('A confirmed action is a usable action');
      expect(t).toContain('Never treat one as unavailable');
      // Told in the prompt AND in the document. One of the two is not enough — the document said it
      // in its header and the build still refused, because the per-line tag read as a warning.
      expect(t).toMatch(/failed\s*\n?the whole run/);
    }
  });

  it('both say WHY, using what actually went wrong', () => {
    for (const t of [goalPrompt(), buildPrompt()]) {
      expect(t).toContain('Look the tools up — do not guess');
      expect(t).toMatch(/wrote a\s*\\?\n?program that could not find Gmail/);
      expect(t).toContain('the documents say so');
    }
  });
});

/**
 * "When I link a new tool will it create a new document immediately?" (BEA-1468)
 *
 * His question, and the honest first answer was NO — it would have waited up to a day. A tool with
 * no document is a tool Codex cannot find, which is precisely how his first real build failed.
 *
 * Two roads, on purpose. Connecting through the UI writes the document at once. The generation
 * watcher catches everything the route handler cannot see: a one-click sign-in that completes
 * minutes later, a second account added to a service, a disconnection from elsewhere.
 */
describe('a newly connected tool gets its document at once', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ToolDocsService } = require('./tool-doc.service');

  function svc(gen: () => number) {
    const rows: any[] = [];
    const prisma: any = {
      toolDoc: {
        findMany: async () => rows,
        findUnique: async ({ where }: any) => rows.find((r) => r.service === where.service) || null,
        upsert: async ({ where, create, update }: any) => {
          const now = rows.find((r) => r.service === where.service);
          if (now) Object.assign(now, update);
          else rows.push({ service: where.service, ...create });
        },
      },
    };
    const catalog: any = { catalog: async () => ({ tools: [{ id: 'svc:notion.create_notion_page', service: 'notion', name: 'Create a page', connected: true }] }) };
    const s = new ToolDocsService(prisma, catalog, undefined, { generation: gen });
    return { s, rows };
  }

  it('rebuilds when the connection generation moves', async () => {
    let gen = 1;
    const { s, rows } = svc(() => gen);
    await s.rebuild();
    expect(rows).toHaveLength(1);

    // Nothing changed → the watcher does nothing at all.
    rows.length = 0;
    await (s as any).ifConnectionsChanged();
    expect(rows).toHaveLength(0);

    // He connects something → the generation moves → the documents are rewritten.
    gen = 2;
    await (s as any).ifConnectionsChanged();
    expect(rows).toHaveLength(1);
    expect(rows[0].service).toBe('notion');
  });

  it('does not rewrite a document whose text has not changed', async () => {
    const { s, rows } = svc(() => 1);
    await s.rebuild();
    const first = rows[0].text;
    const out = await s.rebuild();
    expect(out.changed).toBe(0);      // the hash matched, so the row was left alone
    expect(rows[0].text).toBe(first);
  });

  it('the connect route asks for a rebuild without waiting on it', () => {
    // Never awaited: a catalogue walk must not hold up the connect he is standing in front of.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('path');
    const src = readFileSync(join(__dirname, 'services.controller.ts'), 'utf8');
    expect(src).toContain('void this.docs?.rebuild?.()');
    // …and a DISCONNECTED tool must stop claiming its actions can be called.
    expect(src.split('void this.docs?.rebuild?.()').length - 1).toBe(2);
  });
});

/**
 * WHICH TOOLS DOES HIS CONVERSATION NAME? (BEA-1472)
 *
 * He named no tools in the chat, so Codex had to discover them. It was told to pin exact ids, and it
 * pinned `svc:whatsapp.send_message` — which does not exist. `svc:whatsapp.send_text` was one lookup
 * away in a document it did not open.
 *
 * So the documents for the tools his words actually mention now go INTO the prompt. This match is
 * mechanical on purpose: it decides nothing, it only notices that a word is present.
 */
describe('the tools his words mention', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { toolsNamedIn } = require('./tool-doc');
  const known = [
    { service: 'gmail', name: 'Gmail' },
    { service: 'notion', name: 'Notion' },
    { service: 'whatsapp', name: 'Whatsapp' },
    { service: 'instagram', name: 'Instagram' },
    { service: 'github', name: 'Github' },
  ];

  it('finds the ones he actually talked about', () => {
    const said = 'Every day at 22:00 read my Gmail, write the summary to a Notion page, and send the link on WhatsApp.';
    expect(toolsNamedIn(said, known).sort()).toEqual(['gmail', 'notion', 'whatsapp']);
  });

  it('does not drag in the ones he never mentioned', () => {
    const said = 'Read my Gmail and put it in Notion.';
    expect(toolsNamedIn(said, known)).not.toContain('instagram');
    expect(toolsNamedIn(said, known)).not.toContain('github');
  });

  it('matches whole words only — "notional" is not Notion', () => {
    expect(toolsNamedIn('this is a notional example', known)).toEqual([]);
    expect(toolsNamedIn('gmailbox', known)).toEqual([]);
  });

  it('is case-insensitive, because he types how he types', () => {
    expect(toolsNamedIn('send it on whatsapp please', known)).toEqual(['whatsapp']);
  });

  it('says nothing rather than guessing when he named nothing', () => {
    expect(toolsNamedIn('do the usual thing every night', known)).toEqual([]);
    expect(toolsNamedIn('', known)).toEqual([]);
  });
});
