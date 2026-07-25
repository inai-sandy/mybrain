import { AgentsImportService } from './agents-import.service';

describe('AgentsImportService (BEA-1081)', () => {
  const svc = new AgentsImportService({} as any);

  it('parses the community one-file agent convention (frontmatter + body)', () => {
    const raw = `---
name: code-reviewer
description: Use when reviewing pull requests for bugs and style.
tools: Read, Grep, Glob
model: sonnet
color: "#f97316"
---
You are a careful reviewer.
1. Read the diff.
2. Flag real bugs only.`;
    const a = svc.parseAgentMd(raw, 'agents/code-reviewer.md')!;
    expect(a.name).toBe('code-reviewer');
    expect(a.description).toContain('reviewing pull requests');
    expect(a.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(a.model).toBe('sonnet');
    expect(a.color).toBe('#f97316');
    expect(a.body).toContain('Flag real bugs only');
  });

  it('rejects files without frontmatter or without name+description', () => {
    expect(svc.parseAgentMd('# just a readme\nhello', 'README.md')).toBeNull();
    expect(svc.parseAgentMd('---\nname: x\n---\nbody', 'x.md')).toBeNull(); // no description
  });

  it('sniffs MCP servers from mcp.json and CLIs from README npm -g lines — and nothing else', () => {
    const deps = svc.sniffDeps([
      { rel: '.mcp.json', text: JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } } }) },
      { rel: 'README.md', text: 'Install: `npm install -g task-master-ai`\nOr: curl -fsSL https://x.sh | sh\nUses PreToolUse hooks.' },
      { rel: 'sub/agent.md', text: 'not a config' },
    ]);
    expect(deps.mcpServers).toEqual([{ name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }]);
    expect(deps.clis).toEqual(['task-master-ai']);
    // the curl|sh line is NEVER an install target — only a note
    expect(deps.notes.some((n) => n.includes('curl|sh'))).toBe(true);
    expect(deps.notes.some((n) => n.toLowerCase().includes('hooks'))).toBe(true);
  });
});

/** BEA-1100: the imported agent's Tools section = declared tools + repo MCP servers + CLIs. */
describe('toolsFromImport (BEA-1100)', () => {
  it('maps declared tools, MCP servers and CLIs with honest install status', async () => {
    const { AgentsImportService } = await import('./agents-import.service');
    const svc = new (AgentsImportService as any)({});
    const out = svc.toolsFromImport(
      { tools: ['WebSearch'] },
      { mcpServers: [{ name: 'tavily', command: 'npx', args: [] }], clis: ['@tavily/cli'], notes: [] },
      false,
    );
    expect(out).toEqual([
      { kind: 'api', name: 'WebSearch', note: 'named in the agent definition', status: 'installed' },
      { kind: 'mcp', name: 'tavily', note: 'npx', status: 'needed' },
      { kind: 'cli', name: '@tavily/cli', status: 'needed' },
    ]);
    expect(svc.toolsFromImport({ tools: [] }, { mcpServers: [], clis: ['x'], notes: [] }, true)[0].status).toBe('installed');
  });
});

/** BEA-1105: the whole repo becomes ONE agent (area); picked definitions are jobs inside it. */
describe('confirm builds one area per repo (BEA-1105)', () => {
  it('creates the repo area, puts jobs inside, aggregates deduped tools', async () => {
    const { AgentsImportService } = await import('./agents-import.service');
    const created: any[] = [];
    const areaCalls: any[] = [];
    const agent: any = { createAgent: jest.fn(async (i: any) => { created.push(i); return { id: 'j' + created.length, areaId: i.areaId }; }) };
    const areas: any = {
      create: jest.fn(async (i: any) => { areaCalls.push(['create', i]); return { id: 'ar-repo', ...i }; }),
      update: jest.fn(async (id: string, patch: any) => { areaCalls.push(['update', id, patch]); return {}; }),
    };
    const svc: any = new (AgentsImportService as any)(agent, areas);
    jest.spyOn(svc, 'preview').mockResolvedValue({
      url: 'https://github.com/acme/news-agents',
      readme: '# News agents\nA pack of news agents for daily briefs.\n',
      agents: [
        { name: 'tech-news', description: 'tech', body: 'do tech news', tools: ['WebSearch'], color: null },
        { name: 'ai-news', description: 'ai', body: 'do ai news', tools: ['WebSearch'], color: null },
      ],
      deps: { mcpServers: [{ name: 'tavily', command: 'npx', args: [] }], clis: [], notes: [] },
    });
    const out = await svc.confirm('https://github.com/acme/news-agents', ['tech-news', 'ai-news'], false);
    expect(out.imported).toEqual(['tech-news', 'ai-news']);
    expect(out.areaId).toBe('ar-repo');
    expect(out.url).toBe('/agent/ar/ar-repo');
    expect(areaCalls[0][1].name).toBe('news agents'); // repo name, cleaned
    expect(areaCalls[0][1].description).toContain('pack of news agents'); // readme first real line
    expect(created.every((c) => c.areaId === 'ar-repo')).toBe(true); // jobs live INSIDE the repo area
    const tools = areaCalls.find((c) => c[0] === 'update')![2].tools;
    expect(tools.filter((t: any) => t.name === 'WebSearch').length).toBe(1); // deduped across jobs
    expect(tools.some((t: any) => t.name === 'tavily' && t.kind === 'mcp' && t.status === 'needed')).toBe(true);
  });
});
