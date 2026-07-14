import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join, dirname, relative, basename } from 'path';
import { randomBytes, createHash } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip: any = require('adm-zip');
import { SkillsService, parseSkillMd, repairSkillMd } from './skills.service';

/** A stable content hash of a skill folder (sorted relative paths + file bytes) — "changed since import?". */
async function hashFolder(root: string): Promise<string> {
  const h = createHash('sha1');
  const files: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') await walk(p); }
      else if (e.isFile()) files.push(p);
    }
  };
  await walk(root);
  files.sort();
  for (const f of files) {
    h.update(relative(root, f));
    try { h.update(await fs.readFile(f)); } catch { /* ignore */ }
  }
  return h.digest('hex');
}

function packSlug(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

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

  private async downloadZip(owner: string, repo: string, ref?: string): Promise<{ buf: Buffer; ref: string }> {
    const tries: { t: string; ref: string }[] = [];
    if (ref) { tries.push({ t: `refs/heads/${ref}`, ref }, { t: `refs/tags/${ref}`, ref }, { t: ref, ref }); }
    else { tries.push({ t: 'refs/heads/main', ref: 'main' }, { t: 'refs/heads/master', ref: 'master' }); }
    for (const { t, ref: r } of tries) {
      const url = `https://codeload.github.com/${owner}/${repo}/zip/${t}`;
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(45000) }).catch(() => null);
      if (res?.ok) return { buf: Buffer.from(await res.arrayBuffer()), ref: r };
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

  /**
   * If the folder has NO SKILL.md but a single wrap-able markdown file, synthesize a SKILL.md from it so a
   * "bare markdown" repo installs as one working skill (BEA-977) — mirrors the terminal tool's shape ③.
   */
  private async wrapBareMarkdown(searchRoot: string, repo: string): Promise<boolean> {
    let entries;
    try { entries = await fs.readdir(searchRoot, { withFileTypes: true }); } catch { return false; }
    const skip = /^(LICENSE|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)/i;
    const mds = entries.filter((e) => e.isFile() && /\.md$/i.test(e.name) && !skip.test(e.name));
    if (mds.length !== 1) return false;
    const src = join(searchRoot, mds[0].name);
    const raw = await fs.readFile(src, 'utf8').catch(() => '');
    if (!raw.trim()) return false;
    const { content } = repairSkillMd(raw, basename(mds[0].name, '.md') || repo);
    await fs.writeFile(join(searchRoot, 'SKILL.md'), content, 'utf8').catch(() => undefined);
    return true;
  }

  /** Step 1: download + extract + list every skill found (no AI, fast — uses each SKILL.md's own description). */
  async preview(rawUrl: string): Promise<{ token: string; repo: string; pack: { id: string; name: string; isPack: boolean }; skills: FoundSkill[] }> {
    await this.sweepOldImports();
    const { owner, repo, ref, subpath } = SkillsImportService.parseGithubUrl(rawUrl);
    const { buf, ref: usedRef } = await this.downloadZip(owner, repo, ref);
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
    let mds = await this.findSkillMds(searchRoot);
    if (!mds.length) {
      // Shape ③ — a "bare markdown" repo: wrap a single .md as a SKILL.md, then re-scan.
      if (await this.wrapBareMarkdown(searchRoot, repo)) mds = await this.findSkillMds(searchRoot);
    }
    if (!mds.length) {
      await fs.rm(tokenDir, { recursive: true, force: true }).catch(() => undefined);
      throw new BadRequestException('No SKILL.md found in that repository or folder (and no single markdown file to wrap).');
    }
    // Remember the source so confirm()/update() can pull it again for the lock model.
    await fs.writeFile(join(tokenDir, 'meta.json'), JSON.stringify({ owner, repo, ref: usedRef, sourceUrl: rawUrl }), 'utf8').catch(() => undefined);
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
    const isPack = unique.length > 1;
    return { token, repo: `${owner}/${repo}`, pack: { id: packSlug(owner, repo), name: repo, isPack }, skills: unique };
  }

  /**
   * Step 2: import the chosen skills. Runs in the BACKGROUND and returns immediately so a big batch
   * never hangs the request past the proxy timeout (BEA-639). The skills appear in the list as they
   * finish; the frontend refreshes to show them.
   */
  async confirm(token: string, paths: string[], deploy: boolean, sourceUrl?: string): Promise<{ started: number }> {
    if (!token || /[^a-f0-9]/i.test(token)) throw new BadRequestException('Bad import token.');
    const tokenDir = join(importsDir(), token);
    await fs.readdir(tokenDir).catch(() => { throw new BadRequestException('This import expired — fetch the URL again.'); });
    const list = (paths || []).map(String).filter(Boolean);
    void this.runImport(tokenDir, list, deploy, sourceUrl).catch((e) => this.log.error(`import run failed: ${e?.message || e}`));
    return { started: list.length };
  }

  private async runImport(tokenDir: string, paths: string[], deploy: boolean, sourceUrl?: string): Promise<void> {
    try {
      const top = await fs.readdir(tokenDir, { withFileTypes: true });
      const rootName = top.find((e) => e.isDirectory())?.name;
      const root = rootName ? join(tokenDir, rootName) : tokenDir;
      const meta = await this.readMeta(tokenDir);
      const sourceRepo = meta ? `${meta.owner}/${meta.repo}` : undefined;
      const packId = meta ? packSlug(meta.owner, meta.repo) : undefined;
      const isPack = paths.length > 1;
      await fs.mkdir(skillsDir(), { recursive: true });
      for (const rel of paths) {
        const safe = rel.replace(/\.\.+/g, '').replace(/^\/+/, '');
        const folder = safe === '.' ? root : join(root, safe);
        if (!folder.startsWith(root)) continue;
        const raw = await fs.readFile(join(folder, 'SKILL.md'), 'utf8').catch(() => null);
        if (raw == null) continue;
        // Repair a missing/blank header so nothing installs half-broken (BEA-977).
        const { content, changed } = repairSkillMd(raw, basename(folder));
        if (changed) await fs.writeFile(join(folder, 'SKILL.md'), content, 'utf8').catch(() => undefined);
        const name = (parseSkillMd(content).name || basename(folder)).slice(0, 120);
        try {
          const folderHash = await hashFolder(folder);
          const source = sourceRepo ? { sourceRepo, sourceRef: meta?.ref, skillPath: safe, sourceUrl: sourceUrl || meta?.sourceUrl, folderHash, packId: isPack ? packId : undefined, packName: isPack ? meta?.repo : undefined } : undefined;
          // No duplicates: if this exact source is already installed, UPDATE it in place instead of adding a copy.
          const existing = sourceRepo ? await this.skills.findBySource(sourceRepo, safe) : null;
          let skillId: string;
          if (existing) {
            const zipPath = join(skillsDir(), `import-${existing.id}.zip`);
            const zip = new AdmZip(); zip.addLocalFolder(folder); zip.writeZip(zipPath);
            await this.skills.refreshFromSource(existing.id, { content, folderHash, sourceRef: meta?.ref, zipPath, redeploy: deploy });
            skillId = existing.id;
          } else {
            // aiDescribe:false → use the SKILL.md's own description; skipping the per-skill LLM call is what
            // takes the import from ~30s/skill down to a couple seconds.
            const skill = await this.skills.create({ title: name, content, origin: 'downloaded', platform: 'code', downloadUrl: sourceUrl || meta?.sourceUrl, aiDescribe: false, source, allowDuplicateTitle: !!sourceRepo });
            const zipPath = join(skillsDir(), `import-${skill.id}.zip`);
            const zip = new AdmZip(); zip.addLocalFolder(folder); zip.writeZip(zipPath);
            await this.skills.attachZip(skill.id, zipPath);
            if (deploy) await this.skills.deployAll(skill.id);
            skillId = skill.id;
          }
          void skillId;
        } catch (e: any) {
          this.log.warn(`skipped "${name}": ${e?.message || e}`);
        }
      }
    } finally {
      await fs.rm(tokenDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readMeta(tokenDir: string): Promise<{ owner: string; repo: string; ref: string; sourceUrl?: string } | null> {
    try { return JSON.parse(await fs.readFile(join(tokenDir, 'meta.json'), 'utf8')); } catch { return null; }
  }

  /**
   * Update ONE installed skill from its recorded source (BEA-977). Re-pulls the repo, finds its skillPath
   * folder, and refreshes in place if the content hash changed. Never creates a duplicate.
   */
  async updateFromSource(skillId: string): Promise<{ ok: boolean; updated: boolean; message: string; newSkills?: { path: string; name: string }[] }> {
    const s: any = await this.skills.get(skillId);
    if (!s) return { ok: false, updated: false, message: 'Skill not found' };
    if (!s.sourceRepo || !s.skillPath) return { ok: false, updated: false, message: 'This skill has no GitHub source to update from.' };
    const [owner, repo] = String(s.sourceRepo).split('/');
    const row: any = await this.skills.findBySource(s.sourceRepo, s.skillPath);
    const { buf, ref } = await this.downloadZip(owner, repo, row?.sourceRef || undefined);
    const token = randomBytes(12).toString('hex');
    const tokenDir = join(importsDir(), token);
    await fs.mkdir(tokenDir, { recursive: true });
    try {
      new AdmZip(buf).extractAllTo(tokenDir, true);
      const top = (await fs.readdir(tokenDir, { withFileTypes: true })).find((e) => e.isDirectory());
      const root = top ? join(tokenDir, top.name) : tokenDir;
      const safe = String(s.skillPath).replace(/\.\.+/g, '').replace(/^\/+/, '');
      const folder = safe === '.' ? root : join(root, safe);
      const raw = await fs.readFile(join(folder, 'SKILL.md'), 'utf8').catch(() => null);
      if (raw == null) return { ok: false, updated: false, message: 'That skill folder no longer exists in the repo.' };
      const { content, changed: repaired } = repairSkillMd(raw, basename(folder));
      if (repaired) await fs.writeFile(join(folder, 'SKILL.md'), content, 'utf8').catch(() => undefined);
      const folderHash = await hashFolder(folder);
      // Any NEW skills the repo has gained since import (flag only — never auto-add).
      const allMds = await this.findSkillMds(root);
      const knownPaths = new Set((await this.skills.listPack(s.packId || '')).map((x: any) => x.skillPath).filter(Boolean));
      knownPaths.add(s.skillPath);
      const newSkills: { path: string; name: string }[] = [];
      for (const md of allMds) {
        const p = relative(root, dirname(md)) || '.';
        if (knownPaths.has(p)) continue;
        const fm = parseSkillMd(await fs.readFile(md, 'utf8').catch(() => ''));
        newSkills.push({ path: p, name: (fm.name || basename(dirname(md))).slice(0, 120) });
      }
      if (folderHash === row?.folderHash && !repaired) {
        // Still bump sourceUpdatedAt so "last checked" is fresh.
        await this.skills.refreshFromSource(skillId, { content: row.content || content, folderHash, sourceRef: ref, redeploy: false });
        return { ok: true, updated: false, message: 'Already up to date.', newSkills };
      }
      const zipPath = join(skillsDir(), `import-${skillId}.zip`);
      const zip = new AdmZip(); zip.addLocalFolder(folder); zip.writeZip(zipPath);
      await this.skills.refreshFromSource(skillId, { content, folderHash, sourceRef: ref, zipPath, redeploy: true });
      return { ok: true, updated: true, message: 'Updated to the latest version.', newSkills };
    } finally {
      await fs.rm(tokenDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Update every skill in a pack from its source; returns a per-skill summary + any new skills found. */
  async updatePack(packId: string): Promise<{ ok: boolean; updated: number; upToDate: number; newSkills: { path: string; name: string }[] }> {
    const rows = await this.skills.listPack(packId);
    if (!rows.length) throw new BadRequestException('No skills in that pack.');
    let updated = 0; let upToDate = 0; const newMap = new Map<string, { path: string; name: string }>();
    for (const s of rows) {
      const r = await this.updateFromSource(s.id).catch(() => null);
      if (r?.updated) updated++; else if (r?.ok) upToDate++;
      for (const n of r?.newSkills || []) newMap.set(n.path, n);
    }
    return { ok: true, updated, upToDate, newSkills: [...newMap.values()] };
  }
}
