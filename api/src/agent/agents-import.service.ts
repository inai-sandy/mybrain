import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentService } from './agent.service';
import { SkillsImportService } from '../skills/skills-import.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip: any = require('adm-zip');

const CODEX_RUNNER = process.env.CODEX_RUNNER_URL || 'http://172.18.0.1:8765';

export type ImportedAgentDef = {
  name: string;
  description: string;
  body: string;
  tools: string[];
  model?: string;
  color?: string;
  file: string;
};
export type ImportDeps = {
  mcpServers: { name: string; command: string; args: string[] }[];
  clis: string[];
  notes: string[];
};
export type ImportPreview = { url: string; agents: ImportedAgentDef[]; deps: ImportDeps; readme?: string };

/**
 * GitHub agent import (BEA-1081) — paste a link, get runnable agents + an INSTALL PLAN. The reader
 * understands the community one-file convention (YAML frontmatter: name/description/tools/model/
 * color + body-as-plan) and sniffs the repo for what the agents need (MCP servers from .mcp.json /
 * config.toml, CLIs from README install lines). NOTHING is installed without the user's tap, and
 * repo install scripts are never executed.
 */
@Injectable()
export class AgentsImportService {
  private readonly log = new Logger('AgentsImport');

  constructor(private readonly agent: AgentService) {}

  /** Parse the flat YAML frontmatter the community agent files use. */
  parseAgentMd(raw: string, file: string): ImportedAgentDef | null {
    const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw.trim());
    if (!m) return null;
    const front: Record<string, string> = {};
    let lastKey = '';
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (kv) { lastKey = kv[1].toLowerCase(); front[lastKey] = kv[2].trim(); }
      else if (lastKey && line.trim()) front[lastKey] += ' ' + line.trim(); // folded multi-line values
    }
    if (!front.name || !front.description) return null;
    const tools = (front.tools || '')
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const colorRaw = (front.color || '').replace(/^['"]|['"]$/g, '');
    return {
      name: front.name.replace(/^['"]|['"]$/g, '').slice(0, 80),
      description: front.description.replace(/^['"]|['"]$/g, '').slice(0, 300),
      body: m[2].trim().slice(0, 8000),
      tools,
      model: front.model || undefined,
      color: colorRaw && /^#?[a-zA-Z0-9]+$/.test(colorRaw) ? colorRaw : undefined,
      file,
    };
  }

  /** Sniff the repo for what the agents need. Detection is honest and conservative. */
  sniffDeps(files: { rel: string; text: string }[]): ImportDeps {
    const deps: ImportDeps = { mcpServers: [], clis: [], notes: [] };
    const seenSrv = new Set<string>();
    const seenCli = new Set<string>();
    for (const f of files) {
      const base = path.basename(f.rel).toLowerCase();
      // MCP server configs: .mcp.json / mcp.json / claude_desktop_config.json style
      if (base === '.mcp.json' || base === 'mcp.json' || base.endsWith('mcp_config.json') || base === 'claude_desktop_config.json') {
        try {
          const j = JSON.parse(f.text);
          const servers = j.mcpServers || j.servers || {};
          for (const [name, cfg] of Object.entries<any>(servers)) {
            if (!cfg?.command || seenSrv.has(name)) continue;
            seenSrv.add(name);
            deps.mcpServers.push({ name: String(name).slice(0, 40), command: String(cfg.command).slice(0, 120), args: Array.isArray(cfg.args) ? cfg.args.map((a: any) => String(a).slice(0, 200)).slice(0, 10) : [] });
          }
        } catch { deps.notes.push(`Could not read ${f.rel}`); }
      }
      // README install hints: npm i -g X (the only CLI install we support — no curl|bash, ever)
      if (base.startsWith('readme')) {
        for (const mm of f.text.matchAll(/npm\s+(?:install|i)\s+(?:-g|--global)\s+([@\w./-]+)/g)) {
          const pkg = mm[1];
          if (/^[@a-z0-9][\w@./-]*$/i.test(pkg) && !seenCli.has(pkg)) { seenCli.add(pkg); deps.clis.push(pkg.slice(0, 80)); }
        }
        if (/curl[^\n]*\|\s*(ba)?sh/.test(f.text)) deps.notes.push('The repo suggests a curl|sh install script — those are never run automatically. Check its README if something is missing.');
        if (/\bhooks?\b/i.test(f.text) && /PreToolUse|PostToolUse/.test(f.text)) deps.notes.push('This repo uses Claude-Code hooks — hooks are not supported here; the agents still import.');
      }
    }
    return deps;
  }

  /** Read the repo and build the preview + install plan. Nothing is written anywhere. */
  async preview(rawUrl: string): Promise<ImportPreview> {
    const { owner, repo, ref, subpath } = SkillsImportService.parseGithubUrl(rawUrl);
    const zip = await this.downloadZip(owner, repo, ref);
    const tmp = path.join(os.tmpdir(), `agent-import-${Date.now()}`);
    try {
      new AdmZip(zip).extractAllTo(tmp, true);
      const [rootDir] = await fs.readdir(tmp);
      const root = path.join(tmp, rootDir, subpath || '');
      const files = await this.collectFiles(root);
      if (!files.length) throw new BadRequestException("Couldn't read anything at that link — is it a public repo/folder?");
      const agents: ImportedAgentDef[] = [];
      for (const f of files) {
        if (!f.rel.endsWith('.md')) continue;
        const base = path.basename(f.rel).toLowerCase();
        if (base === 'readme.md' || base === 'skill.md' || base === 'claude.md' || base === 'license.md' || base === 'contributing.md') continue;
        const def = this.parseAgentMd(f.text, f.rel);
        if (def) agents.push(def);
        if (agents.length >= 60) break;
      }
      if (!agents.length) throw new BadRequestException('No agent files found there. Agent files are .md with a name + description header (the community convention).');
      const deps = this.sniffDeps(files);
      const readme = files.find((f) => path.basename(f.rel).toLowerCase().startsWith('readme'))?.text.slice(0, 400);
      return { url: rawUrl, agents, deps, readme };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Import the picked agents (and, if approved, install the plan via the host runner).
   * The agent's frontmatter tools become part of its plan text; its category is 'Imported'.
   */
  async confirm(rawUrl: string, pick: string[], installDeps: boolean): Promise<{ imported: string[]; installed?: any; skipped: string[] }> {
    const prev = await this.preview(rawUrl);
    const wanted = prev.agents.filter((a) => pick.includes(a.name));
    if (!wanted.length) throw new BadRequestException('Pick at least one agent to import.');
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const a of wanted) {
      try {
        const toolsLine = a.tools.length ? `\n\nTools it expects: ${a.tools.join(', ')}. Use my brain tools (search_brain, save_document, ask_user) where they fit.` : '';
        await this.agent.createAgent({
          name: a.name,
          icon: '📦',
          color: a.color && a.color.startsWith('#') ? a.color : undefined,
          category: 'Imported',
          description: a.description,
          prompt: `${a.body}${toolsLine}`.slice(0, 8000),
          autonomy: 'cautious', // imported strangers start careful
          defaultDepth: 'standard',
          sourceUrl: rawUrl,
        } as any);
        imported.push(a.name);
      } catch (e: any) {
        skipped.push(`${a.name}: ${e?.message || 'could not save'}`);
      }
    }
    let installed: any;
    if (installDeps && (prev.deps.mcpServers.length || prev.deps.clis.length)) {
      installed = await this.installOnHost(prev.deps).catch((e) => ({ ok: false, error: e?.message || 'install failed' }));
    }
    return { imported, installed, skipped };
  }

  /** Hand the approved plan to the host runner (config.toml MCP entries + npm -g CLIs only). */
  private async installOnHost(deps: ImportDeps): Promise<any> {
    const r = await fetch(`${CODEX_RUNNER}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mcpServers: deps.mcpServers, clis: deps.clis }),
      signal: AbortSignal.timeout(180000),
    });
    return r.json().catch(() => ({ ok: false, error: 'no reply from the engine host' }));
  }

  private async downloadZip(owner: string, repo: string, ref?: string): Promise<Buffer> {
    for (const t of ref ? [ref] : ['HEAD', 'main', 'master']) {
      const r = await fetch(`https://codeload.github.com/${owner}/${repo}/zip/${t}`, { signal: AbortSignal.timeout(60000) }).catch(() => null);
      if (r?.ok) return Buffer.from(await r.arrayBuffer());
    }
    throw new BadRequestException("Couldn't download that repo — is the link right and public?");
  }

  private async collectFiles(root: string, limit = 400): Promise<{ rel: string; text: string }[]> {
    const out: { rel: string; text: string }[] = [];
    const walk = async (dir: string, rel: string) => {
      if (out.length >= limit) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (out.length >= limit) return;
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        const p = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(p, r);
        else if (/\.(md|json|toml|ya?ml)$/i.test(e.name)) {
          const stat = await fs.stat(p).catch(() => null);
          if (stat && stat.size <= 300_000) out.push({ rel: r, text: await fs.readFile(p, 'utf8').catch(() => '') });
        }
      }
    };
    await walk(root, '');
    return out;
  }
}
