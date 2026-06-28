import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join, dirname, relative, basename } from 'path';
import { randomBytes } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip: any = require('adm-zip');
import { SkillsService, parseSkillMd } from './skills.service';

function importsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'skill-imports');
}
function skillsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'skills');
}

type FoundSkill = { path: string; name: string; description: string; alreadyInLibrary: boolean };

/**
 * SkillsImportService (BEA-635) — import skills straight from a GitHub URL. Downloads the repo as a
 * ZIP via codeload (no git binary), extracts with AdmZip, finds every SKILL.md, and lets the user pick
 * which to import. Picked skills keep their whole folder (assets/references) via a per-skill zip, then
 * can deploy everywhere (Claude folders + Hermes) using the BEA-634 deploy path.
 */
@Injectable()
export class SkillsImportService {
  private readonly log = new Logger('SkillsImport');

  constructor(private readonly skills: SkillsService) {}

  /** Parse a GitHub URL (repo / tree-subpath / blob-or-raw SKILL.md) into its parts. */
  static parseGithubUrl(raw: string): { owner: string; repo: string; ref?: string; subpath?: string } {
    let u = (raw || '').trim();
    if (!u) throw new BadRequestException('Paste a GitHub URL.');
    u = u.replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git(\/|$)/, '$1');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    let url: URL;
    try { url = new URL(u); } catch { throw new BadRequestException('That does not look like a valid URL.'); }
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (host === 'raw.githubusercontent.com') {
      // /owner/repo/ref/sub/path/SKILL.md
      const [owner, repo, ref, ...rest] = parts;
      if (!owner || !repo) throw new BadRequestException('Could not read owner/repo from that raw URL.');
      let sub = rest.join('/');
      if (/SKILL\.md$/i.test(sub)) sub = dirname(sub);
      return { owner, repo, ref, subpath: sub && sub !== '.' ? sub : undefined };
    }
    if (host === 'github.com' || host === 'www.github.com') {
      const [owner, repo, kind, ref, ...rest] = parts;
      if (!owner || !repo) throw new BadRequestException('Could not read owner/repo from that GitHub URL.');
      if (kind === 'tree' || kind === 'blob') {
        let sub = rest.join('/');
        if (/SKILL\.md$/i.test(sub)) sub = dirname(sub);
        return { owner, repo, ref, subpath: sub && sub !== '.' ? sub : undefined };
      }
      return { owner, repo };
    }
    throw new BadRequestException('Only GitHub URLs are supported for now.');
  }

  private async downloadZip(owner: string, repo: string, ref?: string): Promise<Buffer> {
    const tries: string[] = [];
    if (ref) { tries.push(`refs/heads/${ref}`, `refs/tags/${ref}`, ref); }
    else { tries.push('refs/heads/main', 'refs/heads/master'); }
    for (const t of tries) {
      const url = `https://codeload.github.com/${owner}/${repo}/zip/${t}`;
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(45000) }).catch(() => null);
      if (res?.ok) return Buffer.from(await res.arrayBuffer());
    }
    throw new BadRequestException(`Could not download ${owner}/${repo}${ref ? ` (branch “${ref}”)` : ''} — check the URL is public and correct.`);
  }

  /** Recursively collect SKILL.md file paths under a directory. */
  private async findSkillMds(root: string, limit = 300): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      if (out.length >= limit) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit) return;
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') await walk(p); }
        else if (e.isFile() && e.name.toLowerCase() === 'skill.md') out.push(p);
      }
    };
    await walk(root);
    return out;
  }

  private async sweepOldImports() {
    const dir = importsDir();
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      const st = await fs.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Step 1: download + extract + list every skill found (no AI, fast — uses each SKILL.md's own description). */
  async preview(rawUrl: string): Promise<{ token: string; repo: string; skills: FoundSkill[] }> {
    await this.sweepOldImports();
    const { owner, repo, ref, subpath } = SkillsImportService.parseGithubUrl(rawUrl);
    const buf = await this.downloadZip(owner, repo, ref);
    const token = randomBytes(12).toString('hex');
    const tokenDir = join(importsDir(), token);
    await fs.mkdir(tokenDir, { recursive: true });
    try {
      new AdmZip(buf).extractAllTo(tokenDir, true);
    } catch {
      await fs.rm(tokenDir, { recursive: true, force: true }).catch(() => undefined);
      throw new BadRequestException('Could not unpack the repository.');
    }
    // The zip wraps everything in a single top folder: {repo}-{ref}
    const top = (await fs.readdir(tokenDir, { withFileTypes: true })).find((e) => e.isDirectory());
    const root = top ? join(tokenDir, top.name) : tokenDir;
    const safeSub = (subpath || '').replace(/\.\.+/g, '').replace(/^\/+/, '');
    const searchRoot = safeSub ? join(root, safeSub) : root;
    const mds = await this.findSkillMds(searchRoot);
    if (!mds.length) {
      await fs.rm(tokenDir, { recursive: true, force: true }).catch(() => undefined);
      throw new BadRequestException('No SKILL.md found in that repository or folder.');
    }
    const skills: FoundSkill[] = [];
    for (const md of mds) {
      const content = await fs.readFile(md, 'utf8').catch(() => '');
      const fm = parseSkillMd(content);
      const folder = dirname(md);
      const name = (fm.name || basename(folder) || 'skill').slice(0, 120);
      const desc = (fm.description || content.replace(/^\s*---[\s\S]*?---/, '').replace(/[#>*`-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || 'No description in the SKILL.md.').slice(0, 400);
      skills.push({ path: relative(root, folder) || '.', name, description: desc, alreadyInLibrary: await this.skills.existsByTitle(name) });
    }
    // de-dup by path, keep order
    const seen = new Set<string>();
    const unique = skills.filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)));
    return { token, repo: `${owner}/${repo}`, skills: unique };
  }

  /** Step 2: import the chosen skills (folder + SKILL.md), optionally deploy everywhere, then clean up. */
  async confirm(token: string, paths: string[], deploy: boolean, sourceUrl?: string): Promise<{ imported: { name: string; id?: string; skipped?: string; deployed?: boolean }[] }> {
    if (!token || /[^a-f0-9]/i.test(token)) throw new BadRequestException('Bad import token.');
    const tokenDir = join(importsDir(), token);
    const top = await fs.readdir(tokenDir, { withFileTypes: true }).catch(() => { throw new BadRequestException('This import expired — fetch the URL again.'); });
    const rootName = top.find((e) => e.isDirectory())?.name;
    const root = rootName ? join(tokenDir, rootName) : tokenDir;
    const results: { name: string; id?: string; skipped?: string; deployed?: boolean }[] = [];
    for (const rel of paths || []) {
      const safe = String(rel).replace(/\.\.+/g, '').replace(/^\/+/, '');
      const folder = safe === '.' ? root : join(root, safe);
      if (!folder.startsWith(root)) { results.push({ name: safe, skipped: 'bad path' }); continue; }
      const mdPath = join(folder, 'SKILL.md');
      const content = await fs.readFile(mdPath, 'utf8').catch(() => null);
      if (content == null) { results.push({ name: safe, skipped: 'no SKILL.md' }); continue; }
      const name = (parseSkillMd(content).name || basename(folder)).slice(0, 120);
      try {
        const skill = await this.skills.create({ title: name, content, origin: 'downloaded', platform: 'code', downloadUrl: sourceUrl });
        // zip the whole folder (assets/references survive) and attach it as the deploy payload
        const zipPath = join(skillsDir(), `import-${skill.id}.zip`);
        await fs.mkdir(skillsDir(), { recursive: true });
        const zip = new AdmZip();
        zip.addLocalFolder(folder);
        zip.writeZip(zipPath);
        await this.skills.attachZip(skill.id, zipPath);
        let deployed = false;
        if (deploy) { const d = await this.skills.deployAll(skill.id); deployed = d.ok; }
        results.push({ name, id: skill.id, deployed });
      } catch (e: any) {
        results.push({ name, skipped: e?.message?.includes('already exists') ? 'already in library' : (e?.message || 'failed') });
      }
    }
    await fs.rm(tokenDir, { recursive: true, force: true }).catch(() => undefined);
    return { imported: results };
  }
}
