import { PublicMcpService } from './public-mcp.service';

function fakePrisma() {
  const settings: any[] = [];
  return {
    _settings: settings,
    setting: {
      findUnique: async ({ where }: any) => settings.find((s) => s.key === where.key) || null,
      upsert: async ({ where, create, update }: any) => {
        const s = settings.find((x) => x.key === where.key);
        if (s) { Object.assign(s, update); return s; }
        const row = { key: where.key, ...create }; settings.push(row); return row;
      },
    },
  };
}
const fakeMem = () => ({
  searchBrain: jest.fn(async () => [{ title: 'Ravi', content: 'prefers WhatsApp', source: 'rag', url: '/documents/doc-1' }]),
  searchRag: jest.fn(async () => [{ title: 'RagHit', content: 'raw vector content', source: 'rag' }]),
});
const fakeDocs = () => ({ get: jest.fn(async (id: string) => (id === 'doc-1' ? { title: 'Doc One', contentText: 'full document body' } : null)) });

function build(mem = fakeMem(), docs = fakeDocs(), prisma = fakePrisma()) {
  return { svc: new PublicMcpService(prisma as any, mem as any, docs as any), mem, docs, prisma };
}

describe('PublicMcpService (BEA-631)', () => {
  it('initialize advertises tools capability + server info', async () => {
    const { svc } = build();
    const r = await svc.handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(r.result.serverInfo.name).toBe('mybrain-rag');
    expect(r.result.capabilities.tools).toBeDefined();
  });

  it('tools/list returns the three read-only tools', async () => {
    const { svc } = build();
    const r = await svc.handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(r.result.tools.map((t: any) => t.name)).toEqual(['search_brain', 'search_rag', 'fetch_document']);
  });

  it('tools/call search_brain returns formatted hits incl. a document id', async () => {
    const { svc, mem } = build();
    const r = await svc.handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_brain', arguments: { query: 'ravi' } } });
    expect(mem.searchBrain).toHaveBeenCalled();
    expect(r.result.content[0].text).toMatch(/Ravi/);
    expect(r.result.content[0].text).toMatch(/document id: doc-1/);
  });

  it('tools/call search_rag uses the raw RAG path', async () => {
    const { svc, mem } = build();
    const r = await svc.handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_rag', arguments: { query: 'x' } } });
    expect(mem.searchRag).toHaveBeenCalled();
    expect(r.result.content[0].text).toMatch(/raw vector content/);
  });

  it('tools/call fetch_document returns the full body, or a not-found note', async () => {
    const { svc } = build();
    const ok = await svc.handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fetch_document', arguments: { id: 'doc-1' } } });
    expect(ok.result.content[0].text).toMatch(/full document body/);
    const miss = await svc.handleRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fetch_document', arguments: { id: 'nope' } } });
    expect(miss.result.content[0].text).toMatch(/No document found/);
  });

  it('notifications get no response; unknown methods error', async () => {
    const { svc } = build();
    expect(await svc.handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const e = await svc.handleRpc({ jsonrpc: '2.0', id: 7, method: 'does/notexist' });
    expect(e.error.code).toBe(-32601);
  });

  it('authorize: only a correct token AND enabled passes', async () => {
    const { svc } = build();
    const tok = await svc.ensureToken();
    expect(await svc.authorize(tok)).toBe(false); // disabled by default
    await svc.setEnabled(true);
    expect(await svc.authorize(tok)).toBe(true);
    expect(await svc.authorize('wrong')).toBe(false);
    expect(await svc.authorize(undefined)).toBe(false);
  });

  it('regenerate changes the token and invalidates the old one', async () => {
    const { svc } = build();
    await svc.setEnabled(true);
    const old = await svc.ensureToken();
    const { token: fresh } = await svc.regenerate();
    expect(fresh).not.toBe(old);
    expect(await svc.authorize(old)).toBe(false);
    expect(await svc.authorize(fresh)).toBe(true);
  });
});
