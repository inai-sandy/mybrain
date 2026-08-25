import { GoalService } from './goal.service';

/**
 * THE GOAL, end to end on the app's side (BEA-1463).
 *
 * The owner: *"We should ask codex to create a goal and send it for approval. when i approve the
 * goal it has to create an agent…"*
 *
 * What these lock down is mostly what the app must NOT do. Three designs in a row failed because the
 * app read a conversation and wrote something structured from it, and every structure it invented
 * put a defect in front of him. So: the transcript crosses whole, only the tools he named go with
 * it, Codex's text is stored byte for byte, and nothing is built from a goal he has not approved.
 */

function world(opts: { reply?: string | (() => string); rows?: any[] } = {}) {
  const rows: any[] = opts.rows || [];
  const prompts: string[] = [];
  const prisma: any = {
    agentGoal: {
      findFirst: async ({ where, orderBy }: any) => {
        const found = rows
          .filter((r) => r.areaId === where.areaId && (!where.status || r.status === where.status))
          .sort((a, b) => b.version - a.version);
        return found[0] || null;
      },
      create: async ({ data }: any) => {
        const row = { id: `g${rows.length + 1}`, createdAt: new Date(), updatedAt: new Date(), note: null, approvedAt: null, ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
  };
  const llm: any = {
    completeHelper: async (_helper: string, prompt: string) => {
      prompts.push(prompt);
      const r = opts.reply;
      return typeof r === 'function' ? r() : r ?? 'The goal: read Gmail at 22:00 and send the important messages to WhatsApp.';
    },
  };
  const knowledge: any = { card: async (id: string) => ({ actionId: id, name: 'Fetch emails', fields: [], notes: [] }) };
  const samples: any = { replay: async () => ({ data: { messages: [{ id: 'm1' }] } }) };
  return { svc: new GoalService(prisma, llm, knowledge, samples), rows, prompts };
}

const turns = [
  { who: 'you', text: 'Send me my important emails every night.' },
  { who: 'assistant', text: 'Which mailbox?' },
  { who: 'you', text: 'Gmail. On WhatsApp, and I want to read them there.' },
];

describe('asking Codex for the goal', () => {
  it('sends the WHOLE conversation, in order, and nothing about it', async () => {
    const w = world();
    await w.svc.propose('a1', { transcript: turns, tools: ['svc:gmail.fetch_emails'] });
    const p = w.prompts[0];
    expect(p).toContain('Send me my important emails every night');
    expect(p).toContain('Which mailbox?');
    expect(p).toContain('I want to read them there');
    // Not a summary of it. If any of these appear, the app has started interpreting again.
    expect(p).not.toMatch(/in summary|the requirement is|he decided/i);
  });

  it('sends ONLY the tools he named', async () => {
    const w = world();
    await w.svc.propose('a1', { transcript: turns, tools: ['svc:gmail.fetch_emails'] });
    expect(w.prompts[0]).toContain('svc:gmail.fetch_emails');
    // His instruction: "Why do you have to send the full catalog of tools? … I will let you know."
    expect(w.prompts[0]).not.toContain('svc:notion');
    expect(w.prompts[0]).not.toContain('svc:instagram');
  });

  it('stores what Codex wrote, exactly', async () => {
    const written = 'This agent reads your Gmail at 22:00 and sends you the messages that matter, in the message itself.';
    const w = world({ reply: written });
    const g = await w.svc.propose('a1', { transcript: turns, tools: [] });
    expect(g.text).toBe(written);
    expect(g.status).toBe('proposed');
  });

  it('refuses to invent a goal from an empty conversation', async () => {
    const w = world();
    await expect(w.svc.propose('a1', { transcript: [], tools: [] })).rejects.toThrow(/no conversation yet/i);
  });

  it('says plainly when Codex answers nothing, and promises nothing was built', async () => {
    const w = world({ reply: '   ' });
    await expect(w.svc.propose('a1', { transcript: turns, tools: [] })).rejects.toThrow(/Nothing has been built/);
  });
});

describe('when Codex needs him instead', () => {
  it('does not turn a question into a goal he can approve', async () => {
    const w = world({ reply: 'Which Gmail account — work or personal?' });
    const g = await w.svc.propose('a1', { transcript: turns, tools: [] });

    expect(g.status).toBe('asking');
    expect(g.question).toContain('work or personal');
    // THE point: there is nothing to approve yet. A question shown as a draft goal invites him to
    // approve a question mark, and then Codex builds on a guess — which is the whole failure this
    // design replaces.
    expect(g.text).toBe('');
  });

  it('refuses to approve while a question is open, and says what to do', async () => {
    const w = world({ reply: 'Which account?' });
    await w.svc.propose('a1', { transcript: turns, tools: [] });
    await expect(w.svc.approve('a1')).rejects.toThrow(/answer that/i);
  });

  it('his answer goes back in as another turn, and Codex writes the goal', async () => {
    let asked = true;
    const w = world({ reply: () => (asked ? ((asked = false), 'Which Gmail account?') : 'The goal: read the work mailbox at 22:00.') });
    await w.svc.propose('a1', { transcript: turns, tools: [] });

    const g = await w.svc.answer('a1', 'the work one');

    expect(g.status).toBe('proposed');
    expect(g.text).toContain('work mailbox');
    // The second prompt carries the question AND his answer — the conversation grew, it was not
    // replaced by a summary of itself.
    const second = w.prompts[1];
    expect(second).toContain('Which Gmail account?');
    expect(second).toContain('the work one');
    expect(second).toContain('Send me my important emails every night');
  });
});

describe('approving, and sending it back', () => {
  it('only an approved goal is the one a build may stand on', async () => {
    const w = world();
    await w.svc.propose('a1', { transcript: turns, tools: [] });
    expect(await w.svc.approved('a1')).toBeNull(); // proposed is not approved

    const g = await w.svc.approve('a1');
    expect(g.status).toBe('approved');
    expect(g.approvedAt).toBeTruthy();
    expect((await w.svc.approved('a1'))!.id).toBe(g.id);
  });

  it('sending it back carries HIS words to Codex, as the most direct information there is', async () => {
    let first = true;
    const w = world({ reply: () => (first ? ((first = false), 'A goal that misses the point.') : 'A goal that gets it.') });
    await w.svc.propose('a1', { transcript: turns, tools: [] });

    const g = await w.svc.sendBack('a1', 'you missed that I want to READ it on WhatsApp, not click a link');

    expect(g.status).toBe('proposed');
    expect(g.version).toBe(2);
    const second = w.prompts[1];
    expect(second).toContain('He sent your last goal back');
    expect(second).toContain('not click a link');
    expect(second).toContain('A goal that misses the point.'); // what he was rejecting
  });

  it('will not send one back with no reason — that sentence is the whole point', async () => {
    const w = world();
    await w.svc.propose('a1', { transcript: turns, tools: [] });
    await expect(w.svc.sendBack('a1', '   ')).rejects.toThrow(/Say what was wrong/i);
  });

  it('refuses to approve an empty goal', async () => {
    const w = world({ rows: [{ id: 'g0', areaId: 'a1', version: 1, status: 'proposed', text: '', tools: '[]', transcript: '[]' }] });
    await expect(w.svc.approve('a1')).rejects.toThrow(/nothing to approve/i);
  });

  it('refuses to approve when he never asked for one', async () => {
    const w = world();
    await expect(w.svc.approve('a1')).rejects.toThrow(/no goal to approve/i);
  });
});
