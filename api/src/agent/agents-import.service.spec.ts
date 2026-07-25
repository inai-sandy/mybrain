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
