import { Injectable, BadRequestException } from '@nestjs/common';
import { promises as fs, createWriteStream } from 'fs';
import { join } from 'path';
// archiver's runtime is callable as archiver('zip', …); @types/archiver v8 omits that signature, so type it loosely.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver: any = require('archiver');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip: any = require('adm-zip');
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';

/** Parse a SKILL.md's frontmatter for name + description. */
export function parseSkillMd(md: string): { name?: string; description?: string } {
  const m = (md || '').match(/^\s*---\s*([\s\S]*?)\s*---/);
  if (!m) return {};
  const fm = m[1];
  const name = (fm.match(/^name:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '') || undefined;
  let description: string | undefined;
  const dm = fm.match(/^description:\s*(.*)$/m);
  if (dm) {
    let val = dm[1].trim().replace(/^["']|["']$/g, '');
    // YAML block scalar (description: |- / >) — gather the following indented lines.
    if (/^[|>][+-]?$/.test(val)) {
      const lines = fm.split('\n');
      const idx = lines.findIndex((l) => /^description:/.test(l));
      const collected: string[] = [];
      for (let i = idx + 1; i < lines.length; i++) {
        if (/^\s+\S/.test(lines[i]) || lines[i].trim() === '') collected.push(lines[i].trim());
        else break;
      }
      val = collected.join(' ').trim();
    }
    description = val || undefined;
  }
  return { name, description };
}

function skillsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'skills');
}

type CreateInput = { title?: string; description?: string; content?: string; origin?: string; platform?: string; downloadUrl?: string };

@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  /** AI-write a short description of a skill from its SKILL.md (falls back to the given text). */
  async aiDescribe(content: string, fallback?: string): Promise<string> {
    const fb = (fallback || '').trim();
    if (!content?.trim()) return fb;
    const tmpl = await this.prompts.get('skills.describe');
    const prompt = `${tmpl}\n\nSKILL.md:\n${content.slice(0, 5000)}`;
    const text = await this.llm.complete(prompt, 200, 'skill-describe');
    return (text?.trim() || fb).slice(0, 600);
  }

  private shape(s: any) {
    return {
      id: s.id,
      title: s.title,
      slug: s.slug || null,
      description: s.description,
      origin: s.origin,
      platform: s.platform,
      downloadUrl: s.downloadUrl,
      hasFile: !!s.filePath || !!s.content,
      inUse: s.inUse,
      installed: s.installed,
      deployedTo: Object.keys(this.parseJson(s.deployments)), // target names this skill is deployed to (BEA-634)
      lastUsedAt: s.lastUsedAt,
      usageCount: s.usageCount,
      shared: s.shared,
      createdAt: s.createdAt,
    };
  }

  async create(input: CreateInput) {
    const parsed = input.content ? parseSkillMd(input.content) : {};
    const title = (input.title?.trim() || parsed.name || 'Untitled skill').slice(0, 120);
    // Block duplicate names in the list (case-insensitive). Keeps the tracker clean and avoids the
    // confusion of two same-named cards. The filesystem scan has its own upsert and is unaffected.
    const norm = title.trim().toLowerCase();
    const dup = (await this.prisma.skill.findMany({ select: { id: true, title: true } })).find((x) => x.title.trim().toLowerCase() === norm);
    if (dup) throw new BadRequestException(`A skill named “${title}” already exists — open it to update it instead.`);
    // AI-generated description (from the SKILL.md content); fall back to provided/frontmatter text.
    const description = await this.aiDescribe(input.content || '', input.description?.trim() || parsed.description);
    const origin = input.origin === 'downloaded' ? 'downloaded' : 'created';
    const platform = input.platform === 'chat' ? 'chat' : 'code';
    const skill = await this.prisma.skill.create({
      data: { title, description, content: input.content || null, origin, platform, downloadUrl: input.downloadUrl?.trim() || null },
    });
    await this.memory.enqueue(`${title}\n\n${description}`, { title, tags: ['skill', origin] });
    return this.shape(skill);
  }

  async list() {
    const rows = await this.prisma.skill.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 });
    return Promise.all(rows.map(async (s) => ({ ...this.shape(s), installedOn: await this.installedTargets(s) })));
  }

  /** Target names where this skill's folder actually exists on disk right now — the truth for badges (BEA-638). */
  async installedTargets(s: any): Promise<string[]> {
    const dep = this.effectiveDeployments(s);
    const exists = async (p: string) => { try { await fs.stat(p); return true; } catch { return false; } };
    const out: string[] = [];
    for (const [name, dir] of Object.entries(this.deployTargets())) {
      let slug = dep[name] || null;
      if (!slug && s.slug && !s.slug.includes('..') && (await exists(join(dir, s.slug)))) slug = s.slug;
      if (slug && !slug.includes('..') && (await exists(join(dir, slug)))) out.push(name);
    }
    return out;
  }

  async get(id: string) {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return null;
    return { ...this.shape(s), content: s.content };
  }

  async update(id: string, data: { title?: string; description?: string; downloadUrl?: string; origin?: string; platform?: string }) {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return null;
    await this.prisma.skill.update({
      where: { id },
      data: {
        title: data.title?.trim() ? data.title.trim().slice(0, 120) : s.title,
        description: typeof data.description === 'string' ? data.description.slice(0, 2000) : s.description,
        downloadUrl: data.downloadUrl !== undefined ? data.downloadUrl?.trim() || null : s.downloadUrl,
        origin: data.origin === 'downloaded' || data.origin === 'created' ? data.origin : s.origin,
        platform: data.platform === 'chat' || data.platform === 'code' ? data.platform : s.platform,
      },
    });
    return this.get(id);
  }

  async setUsing(id: string, inUse: boolean) {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return null;
    await this.prisma.skill.update({ where: { id }, data: { inUse } });
    return { inUse };
  }

  async setShared(id: string, shared: boolean) {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return null;
    await this.prisma.skill.update({ where: { id }, data: { shared } });
    return { shared };
  }

  /** Public read — only if shared. */
  async getShared(id: string) {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s || !s.shared) return null;
    const slug = (s.slug || s.title || 'skill').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'skill';
    const isZip = !!(s.filePath && s.filePath.toLowerCase().endsWith('.zip'));
    return {
      title: s.title,
      description: s.description,
      platform: s.platform,
      origin: s.origin,
      downloadUrl: s.downloadUrl,
      hasFile: !!s.filePath || !!s.content,
      content: s.content || null,
      slug,
      isZip,
    };
  }

  /** Store an uploaded skill file (.zip/.md). For text files, also keep the content + AI-describe if empty. */
  async addFile(id: string, buffer: Buffer, originalname: string) {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return null;
    const rawExt = (originalname.match(/\.([a-z0-9]+)$/i)?.[1] || 'md').toLowerCase();
    const ext = rawExt === 'markdown' ? 'md' : rawExt;
    const dir = skillsDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = join(dir, `${id}.${ext}`);
    await fs.writeFile(filePath, buffer);
    const data: any = { filePath };
    if (ext === 'md' || ext === 'txt') {
      const text = buffer.toString('utf8');
      data.content = text;
      if (!s.description?.trim()) data.description = await this.aiDescribe(text);
    }
    await this.prisma.skill.update({ where: { id }, data });
    return { ok: true };
  }

  /** Resolve the downloadable file for a skill (optionally requiring it to be shared). */
  async fileFor(id: string, requireShared = false): Promise<{ filePath: string; name: string } | null> {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return null;
    if (requireShared && !s.shared) return null;
    let filePath = s.filePath || null;
    // Skills with only inline content (a single SKILL.md) → materialize a .md on demand.
    if (!filePath && s.content) {
      const dir = skillsDir();
      await fs.mkdir(dir, { recursive: true });
      filePath = join(dir, `${id}.md`);
      await fs.writeFile(filePath, s.content, 'utf8').catch(() => undefined);
    }
    if (!filePath) return null;
    const ext = filePath.split('.').pop() || 'md';
    const base = (s.slug || s.title || 'skill').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
    return { filePath, name: `${base}.${ext}` };
  }

  /** Configured deploy targets, e.g. { sandy: '/scan/sandy/skills', beakn: '/scan/beakn/skills' }. */
  deployTargets(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of (process.env.DEPLOY_SKILLS_DIRS || '').split(',')) {
      const [k, v] = pair.split(':');
      if (k?.trim() && v?.trim()) out[k.trim()] = v.trim();
    }
    return out;
  }

  /** Install a skill into the chosen server Claude Code skills folder. */
  async deploy(id: string, target: string): Promise<{ ok: boolean; message: string }> {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return { ok: false, message: 'Skill not found' };
    const baseDir = this.deployTargets()[target];
    if (!baseDir) return { ok: false, message: 'Unknown deploy target' };
    const baseSlug = (s.slug || s.title || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
    if (!baseSlug || baseSlug.includes('..')) return { ok: false, message: 'Invalid skill name' };

    // Never overwrite a DIFFERENT skill. If we're re-deploying THIS skill to the same target, update
    // its own folder in place. Otherwise pick the next free name (name-2, name-3…) so the existing
    // skill on disk is always preserved.
    const exists = async (p: string) => { try { await fs.stat(p); return true; } catch { return false; } };
    const deployments = this.effectiveDeployments(s); // keep every target already deployed to
    let slug = baseSlug;
    let renamed = false;
    if (deployments[target] && (await exists(join(baseDir, deployments[target])))) {
      slug = deployments[target]; // this skill already lives here for this target — update it in place
    } else if (s.slug && s.source === baseDir && (await exists(join(baseDir, s.slug)))) {
      slug = s.slug; // legacy deploy (before the per-target map) — keep its folder
    } else {
      let n = 1;
      while (await exists(join(baseDir, slug))) {
        n += 1;
        slug = `${baseSlug.slice(0, 76)}-${n}`;
        renamed = true;
      }
    }
    const destDir = join(baseDir, slug);
    try {
      await fs.mkdir(destDir, { recursive: true });
      if (s.filePath && s.filePath.toLowerCase().endsWith('.zip')) {
        new AdmZip(s.filePath).extractAllTo(destDir, true);
      } else if (s.content) {
        await fs.writeFile(join(destDir, 'SKILL.md'), s.content, 'utf8');
      } else if (s.filePath) {
        await fs.writeFile(join(destDir, 'SKILL.md'), await fs.readFile(s.filePath));
      } else {
        return { ok: false, message: 'Nothing to deploy — add the skill file or paste its content first.' };
      }
      deployments[target] = slug;
      await this.prisma.skill.update({ where: { id }, data: { installed: true, slug, source: baseDir, deployments: JSON.stringify(deployments) } });
      const note = renamed ? ` (a skill named “${baseSlug}” already existed there, so this was saved as “${slug}” — the old one is untouched)` : '';
      return { ok: true, message: `Deployed to ${target} → ${slug}${note}` };
    } catch (e: any) {
      return { ok: false, message: 'Deploy failed: ' + (e?.message || 'error') };
    }
  }

  private parseJson(v?: string | null): Record<string, string> {
    try { return v ? JSON.parse(v) : {}; } catch { return {}; }
  }

  /**
   * The per-target deploy map, with any LEGACY single-target record (source/slug) folded in (BEA-636 fix).
   * deploy() overwrites source/slug to the newest target, so without this a skill deployed to A then B
   * would "forget" A. Always merge the legacy record so every target it lives on stays tracked.
   */
  private effectiveDeployments(s: any): Record<string, string> {
    const dep = this.parseJson(s.deployments);
    if (s.slug && s.source) {
      const entry = Object.entries(this.deployTargets()).find(([, dir]) => dir === s.source);
      if (entry && !dep[entry[0]]) dep[entry[0]] = s.slug;
    }
    return dep;
  }

  /** Public wrapper so the GitHub importer can reuse the AI description (BEA-635). */
  describeContent(content: string, fallback?: string): Promise<string> {
    return this.aiDescribe(content || '', fallback);
  }

  /** Attach a pre-built zip (a skill folder with its assets) to a skill so deploy() extracts the full folder (BEA-635). */
  async attachZip(id: string, zipPath: string): Promise<void> {
    await this.prisma.skill.update({ where: { id }, data: { filePath: zipPath } });
  }

  /** Is a skill with this title already in the library? (case-insensitive) */
  async existsByTitle(title: string): Promise<boolean> {
    const norm = title.trim().toLowerCase();
    const rows = await this.prisma.skill.findMany({ select: { title: true } });
    return rows.some((x) => x.title.trim().toLowerCase() === norm);
  }

  /** Deploy to ALL targets at once — one-click "install everywhere" incl. the Hermes agent (BEA-634). */
  async deployAll(id: string): Promise<{ ok: boolean; results: { target: string; ok: boolean; message: string }[] }> {
    const targets = Object.keys(this.deployTargets());
    const results: { target: string; ok: boolean; message: string }[] = [];
    for (const t of targets) results.push({ target: t, ...(await this.deploy(id, t)) });
    return { ok: results.length > 0 && results.every((r) => r.ok), results };
  }

  /** Per-target install status — checks the folder really exists on disk in each target (BEA-634). */
  async deployStatus(id: string): Promise<{ target: string; installed: boolean; slug: string | null }[]> {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return [];
    const deployments = this.effectiveDeployments(s);
    const exists = async (p: string) => { try { await fs.stat(p); return true; } catch { return false; } };
    const out: { target: string; installed: boolean; slug: string | null }[] = [];
    let healed = false;
    for (const [name, dir] of Object.entries(this.deployTargets())) {
      let slug = deployments[name] || null;
      // Heal skills broken by the old bug: if a target has no record but this skill's own folder
      // (its known slug) is on disk there, adopt it.
      if (!slug && s.slug && !s.slug.includes('..') && (await exists(join(dir, s.slug)))) { slug = s.slug; deployments[name] = slug; healed = true; }
      const installed = slug ? await exists(join(dir, slug)) : false;
      out.push({ target: name, installed, slug });
    }
    if (healed) await this.prisma.skill.update({ where: { id }, data: { deployments: JSON.stringify(deployments) } }).catch(() => undefined);
    return out;
  }

  /** Remove a skill from ONE target's folder (BEA-634). */
  async undeploy(id: string, target: string): Promise<{ ok: boolean; message: string }> {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return { ok: false, message: 'Skill not found' };
    const baseDir = this.deployTargets()[target];
    if (!baseDir) return { ok: false, message: 'Unknown deploy target' };
    const deployments = this.effectiveDeployments(s);
    const slug = deployments[target] || '';
    if (!slug || slug.includes('..')) return { ok: false, message: 'Not installed on that target' };
    const destDir = join(baseDir, slug);
    if (!destDir.startsWith(baseDir + '/')) return { ok: false, message: 'Invalid path' };
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
    delete deployments[target];
    await this.prisma.skill.update({ where: { id }, data: { deployments: JSON.stringify(deployments), installed: Object.keys(deployments).length > 0 } });
    return { ok: true, message: `Removed from ${target}` };
  }

  async remove(id: string, uninstall = false) {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return;
    if (uninstall) {
      // Also delete the deployed copies from every server folder this skill lives in (BEA-636).
      const targets = this.deployTargets();
      const folders = new Set<string>();
      for (const [t, slug] of Object.entries(this.effectiveDeployments(s))) { const base = targets[t]; if (base && slug) folders.add(join(base, slug)); }
      for (const dir of folders) {
        const safe = !dir.includes('..') && Object.values(targets).some((base) => dir.startsWith(base + '/'));
        if (safe) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    await this.memory.deleteDoc(s.supermemoryId, s.ragId);
    if (s.filePath) await fs.unlink(s.filePath).catch(() => undefined);
    await this.prisma.skill.delete({ where: { id } });
  }

  private zipFolder(srcDir: string, destZip: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const output = createWriteStream(destZip);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => resolve(true));
        archive.on('error', () => resolve(false));
        archive.pipe(output);
        archive.directory(srcDir, false);
        archive.finalize();
      } catch {
        resolve(false);
      }
    });
  }

  async lastScan(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'skills.lastScan' } });
    return row?.value || null;
  }

  /** Recursively collect .jsonl transcript files (dir names may start with '-'). */
  private async walkJsonl(dir: string, out: string[], depth = 0): Promise<void> {
    if (depth > 6) return;
    let entries: any[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await this.walkJsonl(p, out, depth + 1);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  }

  /** Parse Claude Code transcripts for `/skill` invocations → { slug: {count, last} }. */
  private async parseUsage(): Promise<Map<string, { count: number; last: string }>> {
    const dirs = (process.env.TRANSCRIPT_SCAN_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const files: string[] = [];
    for (const d of dirs) await this.walkJsonl(d, files);
    const usage = new Map<string, { count: number; last: string }>();
    const re = /<command-name>\/([a-zA-Z0-9_-]+)/g;
    for (const f of files) {
      let text: string;
      try {
        text = await fs.readFile(f, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes('<command-name>/')) continue;
        const ts = line.match(/"timestamp":"([0-9T:.+-]+)/)?.[1] || '';
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) {
          const slug = m[1];
          const cur = usage.get(slug) || { count: 0, last: '' };
          cur.count++;
          if (ts && ts > cur.last) cur.last = ts;
          usage.set(slug, cur);
        }
      }
    }
    return usage;
  }

  private async applyUsage() {
    const usage = await this.parseUsage();
    const installed = await this.prisma.skill.findMany({ where: { installed: true }, select: { id: true, slug: true } });
    for (const s of installed) {
      const u = s.slug ? usage.get(s.slug) : undefined;
      await this.prisma.skill.update({
        where: { id: s.id },
        data: { usageCount: u?.count ?? 0, lastUsedAt: u?.last ? new Date(u.last) : null },
      });
    }
  }

  /** Scan the mounted server skill dirs, AI-describe + zip each, upsert (deduped by skill name). */
  async scan(): Promise<{ created: number; updated: number; total: number; lastScan: string }> {
    const dirs = (process.env.SKILLS_SCAN_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const zipDir = skillsDir();
    await fs.mkdir(zipDir, { recursive: true });
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;
    let total = 0;
    for (const base of dirs) {
      let entries: string[] = [];
      try {
        entries = await fs.readdir(base);
      } catch {
        continue;
      }
      for (const slug of entries) {
        if (seen.has(slug)) continue;
        const folder = join(base, slug);
        let md: string;
        try {
          const st = await fs.stat(folder);
          if (!st.isDirectory()) continue;
          md = await fs.readFile(join(folder, 'SKILL.md'), 'utf8');
        } catch {
          continue;
        }
        seen.add(slug);
        total++;
        const parsed = parseSkillMd(md);
        const title = (parsed.name || slug).slice(0, 120);
        const existing = await this.prisma.skill.findFirst({ where: { origin: 'created', slug } });
        // Re-describe only when the skill is new OR its SKILL.md changed since last scan
        // (keeps existing descriptions on unchanged skills → no needless LLM calls).
        const changed = !existing || (existing.content || '') !== md || !existing.description?.trim();
        const description = changed ? await this.aiDescribe(md, existing?.description || parsed.description) : existing.description;
        const zipPath = join(zipDir, `scan-${slug}.zip`);
        const zipped = await this.zipFolder(folder, zipPath);
        if (existing) {
          await this.prisma.skill.update({
            where: { id: existing.id },
            data: { title, description, content: md, installed: true, source: base, filePath: zipped ? zipPath : existing.filePath },
          });
          updated++;
        } else {
          const skill = await this.prisma.skill.create({
            data: { title, description, content: md, origin: 'created', platform: 'code', slug, source: base, installed: true, filePath: zipped ? zipPath : null },
          });
          await this.memory.enqueue(`${title}\n\n${description}`, { itemId: undefined, title, tags: ['skill', 'created'] });
          created++;
        }
      }
    }
    // Update last-used + usage counts from the Claude Code transcripts.
    await this.applyUsage().catch(() => undefined);
    const lastScan = new Date().toISOString();
    await this.prisma.setting.upsert({ where: { key: 'skills.lastScan' }, create: { key: 'skills.lastScan', value: lastScan }, update: { value: lastScan } }).catch(() => undefined);
    return { created, updated, total, lastScan };
  }
}
