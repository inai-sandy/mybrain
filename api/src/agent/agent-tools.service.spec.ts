import { BadRequestException } from '@nestjs/common';
import { AgentToolsService } from './agent-tools.service';

function fakeDocuments() {
  return {
    created: [] as any[],
    convertToCapture: jest.fn(async (_id: string) => ({ ok: true })),
    create: jest.fn(async (input: any) => {
      const doc = { id: 'doc-1', slug: 'research-x-abc123', title: input.title };
      return doc;
    }),
  };
}
function fakeMemory(hits: any[] = []) {
  return { searchBrain: jest.fn(async (_q: string, _n: number) => hits) };
}
function fakeAgent() {
  return {
    ask: jest.fn(async (runId: string, q: any) => ({ id: 'wp-1', resumeToken: 'tok-123', status: 'pending', runId, ...q })),
    attachOutput: jest.fn(async (_runId: string, _docId: string) => ({})),
    _wp: null as any,
    getWaitpoint: jest.fn(async function (this: any, token: string) {
      return token === 'tok-answered' ? { status: 'answered', answer: 'speed' } : token === 'tok-pending' ? { status: 'pending', answer: null } : null;
    }),
  };
}

describe('AgentToolsService — the MCP tool capabilities (BEA-622)', () => {
  describe('save_document', () => {
    it('writes a Document and returns a compact handle', async () => {
      const docs = fakeDocuments();
      const svc = new AgentToolsService(docs as any, fakeMemory() as any, fakeAgent() as any);
      const res = await svc.saveDocument({ title: 'Research X', content: '# notes', tags: ['agent'] });
      expect(docs.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Research X', contentText: '# notes', kind: 'md' }));
      expect(res).toEqual({ id: 'doc-1', slug: 'research-x-abc123', title: 'Research X', url: '/documents/doc-1' });
    });

    it('remembers (indexes) the doc when asked, and links it to the run', async () => {
      const docs = fakeDocuments();
      const agent = fakeAgent();
      const svc = new AgentToolsService(docs as any, fakeMemory() as any, agent as any);
      await svc.saveDocument({ title: 'T', content: 'body', remember: true, runId: 'run-9' });
      expect(docs.convertToCapture).toHaveBeenCalledWith('doc-1');
      expect(agent.attachOutput).toHaveBeenCalledWith('run-9', 'doc-1');
    });

    it('does NOT index by default', async () => {
      const docs = fakeDocuments();
      const svc = new AgentToolsService(docs as any, fakeMemory() as any, fakeAgent() as any);
      await svc.saveDocument({ title: 'T', content: 'body' });
      expect(docs.convertToCapture).not.toHaveBeenCalled();
    });

    it('rejects missing title or content', async () => {
      const svc = new AgentToolsService(fakeDocuments() as any, fakeMemory() as any, fakeAgent() as any);
      await expect(svc.saveDocument({ title: '', content: 'x' } as any)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.saveDocument({ title: 'x', content: '  ' } as any)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('search_brain', () => {
    it('searches the brain and shapes the hits', async () => {
      const mem = fakeMemory([
        { title: 'Ravi note', content: 'Ravi prefers WhatsApp. '.repeat(60), source: 'rag', when: '2026-06-01', url: null, tags: ['person'] },
      ]);
      const svc = new AgentToolsService(fakeDocuments() as any, mem as any, fakeAgent() as any);
      const res = await svc.searchBrain({ query: 'Ravi', limit: 5 });
      expect(mem.searchBrain).toHaveBeenCalledWith('Ravi', 5);
      expect(res.query).toBe('Ravi');
      expect(res.results[0].title).toBe('Ravi note');
      expect(res.results[0].snippet.length).toBeLessThanOrEqual(500);
      expect(res.results[0].source).toBe('rag');
    });

    it('clamps the limit to a sane range and rejects an empty query', async () => {
      const mem = fakeMemory([]);
      const svc = new AgentToolsService(fakeDocuments() as any, mem as any, fakeAgent() as any);
      await svc.searchBrain({ query: 'x', limit: 999 });
      expect(mem.searchBrain).toHaveBeenCalledWith('x', 30); // clamped
      await expect(svc.searchBrain({ query: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('ask_user', () => {
    it('creates a durable waitpoint and returns its token', async () => {
      const agent = fakeAgent();
      const svc = new AgentToolsService(fakeDocuments() as any, fakeMemory() as any, agent as any);
      const res = await svc.askUser({ runId: 'run-1', question: 'Which angle?', kind: 'choice', options: ['cost', 'speed'] });
      expect(agent.ask).toHaveBeenCalledWith('run-1', expect.objectContaining({ question: 'Which angle?', kind: 'choice', options: ['cost', 'speed'] }));
      expect(res.token).toBe('tok-123');
      expect(res.status).toBe('pending');
    });

    it('rejects without a runId', async () => {
      const svc = new AgentToolsService(fakeDocuments() as any, fakeMemory() as any, fakeAgent() as any);
      await expect(svc.askUser({ question: 'x' } as any)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('get_answer', () => {
    it('returns the answer once answered, null while pending', async () => {
      const svc = new AgentToolsService(fakeDocuments() as any, fakeMemory() as any, fakeAgent() as any);
      expect(await svc.getAnswer('tok-pending')).toEqual({ status: 'pending', answer: null });
      expect(await svc.getAnswer('tok-answered')).toEqual({ status: 'answered', answer: 'speed' });
    });

    it('rejects an unknown or missing token', async () => {
      const svc = new AgentToolsService(fakeDocuments() as any, fakeMemory() as any, fakeAgent() as any);
      await expect(svc.getAnswer('nope')).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.getAnswer('')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('validateDraft — the quiet double-check (BEA-1078)', () => {
  function harness(llmOut: string) {
    const annotations: any[] = [];
    const agent: any = {
      ask: jest.fn(async () => ({ id: 'wp1', resumeToken: 't', status: 'pending', kind: 'approve_edit_reject' })),
      getRun: jest.fn(async () => ({ id: 'r1', input: 'Nudge Jayanth about the FRIDAY samples deadline' })),
      getWaitpointById: jest.fn(async () => ({ id: 'wp1', status: 'pending', options: { description: 'Hi Jayanth, reminder the samples are due MONDAY.' } })),
      annotateWaitpoint: jest.fn(async (_id: string, note: string) => { annotations.push(note); }),
    };
    const llm: any = { complete: jest.fn(async () => llmOut) };
    const prompts: any = { get: jest.fn(async () => 'goal: {{goal}} draft: {{draft}} → JSON') };
    const { AgentToolsService } = require('./agent-tools.service');
    const svc = new AgentToolsService({} as any, {} as any, agent, llm, prompts);
    return { svc, agent, annotations };
  }

  it('a mismatched draft gets an amber warning on the card', async () => {
    const h = harness('{"ok": false, "note": "The draft says Monday but the goal says Friday."}');
    await h.svc.validateDraft('r1', 'wp1');
    expect(h.annotations).toEqual(['The draft says Monday but the goal says Friday.']);
  });

  it('a fine draft stays untouched, and validator failures never block the ask', async () => {
    const ok = harness('{"ok": true}');
    await ok.svc.validateDraft('r1', 'wp1');
    expect(ok.annotations).toEqual([]);
    const broken = harness('not json at all');
    await broken.svc.validateDraft('r1', 'wp1'); // must not throw
    expect(broken.annotations).toEqual([]);
  });
});
