import { Injectable, BadRequestException } from '@nestjs/common';
import { promises as fs, createWriteStream } from 'fs';
import { createHash } from 'crypto';
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

/**
 * Ensure a SKILL.md has a valid `name` + `description` frontmatter so Claude Code registers it (BEA-977).
 * Returns the (possibly rewritten) content and whether anything was changed. Additive only — the body is
 * preserved byte-for-byte; we only add/fill the header. Mirrors the terminal tool's repair.
 */
export function repairSkillMd(md: string, fallbackName: string): { content: string; changed: boolean } {
  const text = md || '';
  const { name, description } = parseSkillMd(text);
  if (name && description) return { content: text, changed: false };
  // Split off any existing frontmatter so we can rebuild it cleanly.
  let body = text;
  const fm = text.match(/^\s*---\s*([\s\S]*?)\s*---\s*/);
  if (fm) body = text.slice(fm[0].length);
  const nm = (name || fallbackName || 'skill').trim();
  let desc = (description || '').trim();
  if (!desc) {
    for (const line of body.split('\n')) {
      const t = line.trim().replace(/^#+\s*/, '').trim();
      if (t) { desc = t.slice(0, 200); break; }
    }
    if (!desc) desc = `Imported skill: ${nm}`;
  }
  desc = desc.replace(/"/g, "'");
  return { content: `---\nname: ${nm}\ndescription: "${desc}"\n---\n\n${body.replace(/^\n+/, '')}`, changed: true };
}

function skillsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'skills');
}

type SourceMeta = { sourceRepo?: string; sourceRef?: string; skillPath?: string; sourceUrl?: string; folderHash?: string; packId?: string; packName?: string; bundlePaths?: string[] };
type CreateInput = { title?: string; description?: string; content?: string; origin?: string; platform?: string; downloadUrl?: string; aiDescribe?: boolean; source?: SourceMeta; allowDuplicateTitle?: boolean };

@Injectable()
export class SkillsService {
  private scanning = false; // re-entrancy guard: a slow scan clicked twice must not run concurrently (BEA-961)

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
      // Source tracking / pack grouping (BEA-977)
      sourceRepo: s.sourceRepo || null,
      skillPath: s.skillPath || null,
      sourceUrl: s.sourceUrl || null,
      packId: s.packId || null,
      packName: s.packName || null,
      fromSource: !!s.sourceRepo,
      bundleCount: (() => { try { return s.bundlePaths ? (JSON.parse(s.bundlePaths) as any[]).length : 0; } catch { return 0; } })(),
      sourceUpdatedAt: s.sourceUpdatedAt || null,
      createdAt: s.createdAt,
    };
  }

  async create(input: CreateInput) {
    const parsed = input.content ? parseSkillMd(input.content) : {};
    const title = (input.title?.trim() || parsed.name || 'Untitled skill').slice(0, 120);
    // Block duplicate names in the list (case-insensitive). Keeps the tracker clean and avoids the
    // confusion of two same-named cards. The filesystem scan has its own upsert and is unaffected.
    // Skills imported from a GitHub source are de-duplicated by their SOURCE identity (repo + skillPath),
    // handled by the importer, so two skills from different repos may legitimately share a name — skip the
    // name block for those (BEA-977). Hand-created skills still can't collide by name.
    if (!input.allowDuplicateTitle) {
      const norm = title.trim().toLowerCase();
      const dup = (await this.prisma.skill.findMany({ select: { id: true, title: true } })).find((x) => x.title.trim().toLowerCase() === norm);
      if (dup) throw new BadRequestException(`A skill named “${title}” already exists — open it to update it instead.`);
    }
    // AI-generated description (from the SKILL.md content); fall back to provided/frontmatter text.
    // GitHub import passes aiDescribe:false to skip the per-skill LLM call (the import bottleneck) and
    // use the SKILL.md's own frontmatter description instead (BEA-639).
    const fallbackDesc = (input.description?.trim() || parsed.description || '').trim();
    const description = input.aiDescribe === false
      ? (fallbackDesc || 'Imported skill.').slice(0, 600)
      : await this.aiDescribe(input.content || '', fallbackDesc || undefined);
    const origin = input.origin === 'downloaded' ? 'downloaded' : 'created';
    const platform = input.platform === 'chat' ? 'chat' : 'code';
    const src = input.source || {};
    const skill = await this.prisma.skill.create({
      data: {
        title, description, content: input.content || null, origin, platform, downloadUrl: input.downloadUrl?.trim() || null,
        sourceRepo: src.sourceRepo || null, sourceRef: src.sourceRef || null, skillPath: src.skillPath || null,
        sourceUrl: src.sourceUrl || null, folderHash: src.folderHash || null, packId: src.packId || null, packName: src.packName || null,
        bundlePaths: src.bundlePaths?.length ? JSON.stringify(src.bundlePaths) : null,
        sourceUpdatedAt: src.sourceRepo ? new Date() : null,
      },
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
    let adopted = false; // a skill of this name is already installed here → just use it, don't duplicate
    if (deployments[target] && (await exists(join(baseDir, deployments[target])))) {
      slug = deployments[target]; // this skill already lives here for this target — update it in place
    } else if (s.slug && s.source === baseDir && (await exists(join(baseDir, s.slug)))) {
      slug = s.slug; // legacy deploy (before the per-target map) — keep its folder
    } else if (await exists(join(baseDir, baseSlug))) {
      // A skill with this name is ALREADY installed here. If it's an UNTRACKED folder (e.g. a built-in),
      // adopt it and use it as-is. (BEA-959, user: "just use it")
      // But if another tracked skill owns that folder, adopting would point two rows at one folder —
      // this skill's content would never be written, and removing either would delete the other's live
      // skill. In that case take the next free name instead. (BEA-984)
      if (await this.slugOwnedByOther(id, target, baseSlug)) {
        let i = 2;
        while (await exists(join(baseDir, `${baseSlug}-${i}`))) i++;
        slug = `${baseSlug}-${i}`;
      } else {
        slug = baseSlug;
        adopted = true;
      }
    }
    const destDir = join(baseDir, slug);
    try {
      if (!adopted) {
        // Only write when the skill isn't already there — an adopted skill is used as-is, untouched.
        await fs.mkdir(destDir, { recursive: true });
        if (s.filePath && s.filePath.toLowerCase().endsWith('.zip')) {
          const zip = new AdmZip(s.filePath);
          zip.extractAllTo(destDir, true);
          // AdmZip does NOT apply the Unix modes stored in the zip: everything lands 666 (world-writable)
          // and executables lose +x, which breaks any skill whose SKILL.md runs ./scripts/*.sh. Re-apply
          // the recorded modes. (BEA-986)
          for (const e of zip.getEntries()) {
            const mode = (e.header.attr >>> 16) & 0o7777;
            if (!mode) continue;
            await fs.chmod(join(destDir, e.entryName), mode).catch(() => undefined);
          }
          // The DB's `content` is the source of truth for SKILL.md; the zip only supplies the support
          // files. Without this, a Repair (or any content edit) never reaches disk because the zip still
          // holds the original, broken SKILL.md — and re-deploying would undo an on-disk fix. (BEA-983)
          if (s.content?.trim()) await fs.writeFile(join(destDir, 'SKILL.md'), s.content, 'utf8');
        } else if (s.content) {
          await fs.writeFile(join(destDir, 'SKILL.md'), s.content, 'utf8');
        } else if (s.filePath) {
          await fs.writeFile(join(destDir, 'SKILL.md'), await fs.readFile(s.filePath));
        } else {
          return { ok: false, message: 'Nothing to deploy — add the skill file or paste its content first.' };
        }
      }
      deployments[target] = slug;
      await this.prisma.skill.update({ where: { id }, data: { installed: true, slug, source: baseDir, deployments: JSON.stringify(deployments) } });
      const note = adopted ? ' (already installed here — using the existing one)' : '';
      return { ok: true, message: `Deployed to ${target} → ${slug}${note}` };
    } catch (e: any) {
      return { ok: false, message: 'Deploy failed: ' + (e?.message || 'error') };
    }
  }

  private parseJson(v?: string | null): Record<string, string> {
    try { return v ? JSON.parse(v) : {}; } catch { return {}; }
  }

  /** Does a DIFFERENT tracked skill already occupy this folder name on this target? (BEA-984) */
  private async slugOwnedByOther(id: string, target: string, slug: string): Promise<boolean> {
    const rows = await this.prisma.skill.findMany({ where: { NOT: { id } } });
    return rows.some((r) => this.effectiveDeployments(r)[target] === slug);
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

  /** Find an already-imported skill by its SOURCE identity (repo + path within it) — the update key (BEA-977). */
  async findBySource(sourceRepo: string, skillPath: string): Promise<any | null> {
    if (!sourceRepo || !skillPath) return null;
    return this.prisma.skill.findFirst({ where: { sourceRepo, skillPath } });
  }

  /** Find an existing BUNDLE skill for a repo (one row that holds many sub-skills) — the update/dedup key (BEA-979). */
  async findBundleBySource(sourceRepo: string): Promise<any | null> {
    if (!sourceRepo) return null;
    const rows = await this.prisma.skill.findMany({ where: { sourceRepo } });
    return rows.find((r) => !!r.bundlePaths) || null;
  }

  /** Refresh an existing skill's files + metadata from a freshly-pulled source folder, then redeploy (BEA-977). */
  async refreshFromSource(id: string, opts: { content: string; folderHash: string; sourceRef?: string; zipPath?: string; redeploy?: boolean }): Promise<void> {
    const parsed = parseSkillMd(opts.content);
    const data: any = {
      content: opts.content,
      folderHash: opts.folderHash,
      sourceUpdatedAt: new Date(),
    };
    if (opts.sourceRef) data.sourceRef = opts.sourceRef;
    if (parsed.description?.trim()) data.description = parsed.description.trim().slice(0, 600);
    if (opts.zipPath) data.filePath = opts.zipPath;
    await this.prisma.skill.update({ where: { id }, data });
    if (opts.redeploy) await this.deployAll(id).catch(() => undefined);
  }

  /** Repair a skill's missing/blank frontmatter header in place, then redeploy so the fix reaches disk (BEA-977). */
  async repairSkill(id: string): Promise<{ ok: boolean; changed: boolean; message: string }> {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return { ok: false, changed: false, message: 'Skill not found' };
    if (!s.content?.trim()) return { ok: false, changed: false, message: 'This skill has no SKILL.md text to repair.' };
    const { content, changed } = repairSkillMd(s.content, s.slug || s.title);
    if (!changed) return { ok: true, changed: false, message: 'Header already looks good.' };
    const parsed = parseSkillMd(content);
    await this.prisma.skill.update({ where: { id }, data: { content, description: parsed.description?.trim() ? parsed.description.trim().slice(0, 600) : s.description } });
    if (Object.keys(this.effectiveDeployments(s)).length) await this.deployAll(id).catch(() => undefined);
    return { ok: true, changed: true, message: 'Repaired the header.' };
  }

  /** All skills belonging to one imported pack (a multi-skill repo), newest first. */
  async listPack(packId: string): Promise<any[]> {
    if (!packId) return [];
    return this.prisma.skill.findMany({ where: { packId }, orderBy: { createdAt: 'desc' } });
  }

  /** Every skill imported from a given repo — however it was installed (single, pack, or bundle). (BEA-984) */
  async listBySourceRepo(sourceRepo: string): Promise<any[]> {
    if (!sourceRepo) return [];
    return this.prisma.skill.findMany({ where: { sourceRepo } });
  }

  /** Remove every skill in a pack (library + deploy folders). */
  async removePack(packId: string, uninstall = true): Promise<{ removed: number }> {
    const rows = await this.listPack(packId);
    for (const s of rows) await this.remove(s.id, uninstall).catch(() => undefined);
    return { removed: rows.length };
  }

  /**
   * Doctor — scan the library for problems (BEA-977):
   *  - duplicates: >1 row sharing the same source identity, OR the same title
   *  - broken: SKILL.md content missing a name/description header
   * Returns a report; applyCleanup() fixes them (repair headers, delete the extra duplicate copies).
   */
  async cleanupScan(): Promise<{ duplicates: { keep: string; remove: string[]; label: string }[]; broken: { id: string; title: string }[] }> {
    const rows = await this.prisma.skill.findMany({ orderBy: { createdAt: 'asc' } });
    // Two rows are duplicates if they share ANY of: the same GitHub source, the same SKILL.md content
    // (catches "deep-research" vs "deep-research-2" renames), or the same title. Merge overlapping
    // matches into one group so a pair matched by two signals isn't double-reported (BEA-978).
    const keysOf = (s: any): string[] => {
      const ks: string[] = [];
      if (s.sourceRepo && s.skillPath) ks.push(`src:${s.sourceRepo}#${s.skillPath}`);
      if (s.content?.trim()) ks.push(`content:${createHash('sha1').update(s.content.trim()).digest('hex')}`);
      // Title matching is ONLY safe for hand-created skills. Imported skills from DIFFERENT repos may
      // legitimately share a generic name ("design", "pdf") — create() deliberately allows that — and
      // grouping those by title alone would make Clean up delete a real, unrelated skill. Imported
      // skills are deduped by their source identity and content instead. (BEA-984)
      if (!s.sourceRepo) ks.push(`title:${s.title.trim().toLowerCase()}`);
      return ks;
    };
    const groups: { rows: any[]; keys: Set<string> }[] = [];
    for (const s of rows) {
      const ks = keysOf(s);
      let g = groups.find((gr) => ks.some((k) => gr.keys.has(k)));
      if (!g) { g = { rows: [], keys: new Set() }; groups.push(g); }
      g.rows.push(s); ks.forEach((k) => g.keys.add(k));
    }
    const duplicates: { keep: string; remove: string[]; label: string }[] = [];
    for (const g of groups) {
      if (g.rows.length < 2) continue;
      // Keep the one that is deployed / oldest; remove the rest.
      const sorted = [...g.rows].sort((a, b) => (Object.keys(this.parseJson(b.deployments)).length - Object.keys(this.parseJson(a.deployments)).length) || (a.createdAt < b.createdAt ? -1 : 1));
      duplicates.push({ keep: sorted[0].id, remove: sorted.slice(1).map((x) => x.id), label: sorted[0].title });
    }
    const broken: { id: string; title: string }[] = [];
    for (const s of rows) {
      if (!s.content?.trim()) continue;
      const p = parseSkillMd(s.content);
      if (!p.name || !p.description) broken.push({ id: s.id, title: s.title });
    }
    return { duplicates, broken };
  }

  /** Apply the doctor fixes: repair broken headers, delete duplicate copies. */
  async cleanupApply(): Promise<{ repaired: number; removed: number }> {
    const { duplicates, broken } = await this.cleanupScan();
    let repaired = 0; let removed = 0;
    for (const b of broken) { const r = await this.repairSkill(b.id).catch(() => null); if (r?.changed) repaired++; }
    for (const d of duplicates) for (const id of d.remove) { await this.remove(id, true).catch(() => undefined); removed++; }
    return { repaired, removed };
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
    if (this.scanning) {
      // A scan is already running (a slow scan clicked twice) — don't race and duplicate. (BEA-961)
      const last = (await this.prisma.setting.findUnique({ where: { key: 'skills.lastScan' } }))?.value || new Date().toISOString();
      return { created: 0, updated: 0, total: 0, lastScan: last };
    }
    this.scanning = true;
    try {
    const dirs = (process.env.SKILLS_SCAN_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean);
    // Match existing skills by NAME (their stable identity) — NOT by folder-slug or origin — so a re-scan
    // updates in place instead of duplicating imported skills or "-2"-suffixed folders. Preloaded once. (BEA-961)
    const norm = (x: string) => (x || '').trim().toLowerCase();
    const byName = new Map<string, any>();
    for (const sk of await this.prisma.skill.findMany()) if (!byName.has(norm(sk.title))) byName.set(norm(sk.title), sk);
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
        const existing = byName.get(norm(title)) || null; // match by name, not folder-slug/origin (BEA-961)
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
          byName.set(norm(title), skill); // so a second folder of the same name in this scan updates, not duplicates
          created++;
        }
      }
    }
    // Update last-used + usage counts from the Claude Code transcripts.
    await this.applyUsage().catch(() => undefined);
    const lastScan = new Date().toISOString();
    await this.prisma.setting.upsert({ where: { key: 'skills.lastScan' }, create: { key: 'skills.lastScan', value: lastScan }, update: { value: lastScan } }).catch(() => undefined);
    return { created, updated, total, lastScan };
    } finally {
      this.scanning = false;
    }
  }
}
