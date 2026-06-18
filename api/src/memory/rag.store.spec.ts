import { RagStore } from './rag.store';

function mcpText(payload: any) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** A RagStore wired to a fake in-memory MCP client so we can assert tool routing + merging. */
class TestRagStore extends RagStore {
  connectCount = 0;
  calls: Array<{ name: string; arguments: any }> = [];
  responders: Record<string, (args: any) => any> = {};

  protected async createClient(): Promise<any> {
    this.connectCount++;
    return {
      callTool: async ({ name, arguments: args }: any) => {
        this.calls.push({ name, arguments: args });
        const fn = this.responders[name];
        return mcpText(fn ? fn(args) : { ok: true });
      },
      close: async () => undefined,
    };
  }
}

describe('RagStore.save — chunk routing', () => {
  it('uses save_doc for short content and returns its id', async () => {
    const s = new TestRagStore();
    s.responders['save_doc'] = () => ({ ok: true, id: 'whole-1' });
    const id = await s.save('a short note', 'Note');
    expect(s.calls[0].name).toBe('save_doc');
    expect(id).toBe('whole-1');
  });

  it('uses save_chunked_doc for long content and returns the parent_id', async () => {
    const s = new TestRagStore();
    s.responders['save_chunked_doc'] = () => ({ ok: true, parent_id: 'parent-9', chunks_created: 7 });
    const long = 'x'.repeat(5000); // > CHUNK_THRESHOLD
    const id = await s.save(long, 'Long brief');
    expect(s.calls[0].name).toBe('save_chunked_doc');
    expect(id).toBe('parent-9');
  });
});

describe('RagStore.search — whole + chunk merge', () => {
  it('surfaces a chunk hit (the tail of a long doc) mapped to its parent, ranked by score', async () => {
    const s = new TestRagStore();
    s.responders['search_docs'] = () => ({
      results: [{ id: 'docA', title: 'Doc A', content: 'whole A', tags: ['research'], similarity: 0.55 }],
    });
    s.responders['search_chunked_docs'] = () => ({
      results: [
        {
          chunk_id: 'c1',
          chunk_content: 'the buried fact near the end',
          chunk_heading: 'Appendix',
          parent_id: 'docB',
          parent_title: 'Doc B',
          parent_tags: ['research'],
          similarity: 0.91,
        },
      ],
    });

    const hits = await s.search('the buried fact', 5);

    // Highest score first — the chunk hit beats the whole-doc hit.
    expect(hits[0].id).toBe('docB');
    expect(hits[0].content).toBe('the buried fact near the end');
    expect(hits[0].score).toBe(0.91); // normRag reads .score (was previously undefined for RAG)
    expect(hits[1].id).toBe('docA');
  });

  it('de-dups when a whole-doc and its own chunk both match, keeping the best score', async () => {
    const s = new TestRagStore();
    s.responders['search_docs'] = () => ({
      results: [{ id: 'docA', title: 'Doc A', content: 'whole A', similarity: 0.6 }],
    });
    s.responders['search_chunked_docs'] = () => ({
      results: [{ chunk_id: 'c1', chunk_content: 'section of A', parent_id: 'docA', parent_title: 'Doc A', similarity: 0.8 }],
    });

    const hits = await s.search('a', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('docA');
    expect(hits[0].score).toBe(0.8);
  });
});

describe('RagStore — pooled connection', () => {
  it('connects once and reuses the client across calls', async () => {
    const s = new TestRagStore();
    s.responders['save_doc'] = () => ({ id: 'x' });
    s.responders['search_docs'] = () => ({ results: [] });
    s.responders['search_chunked_docs'] = () => ({ results: [] });

    await s.save('one', 'a');
    await s.search('q');
    await s.search('q2');

    expect(s.connectCount).toBe(1);
  });
});
