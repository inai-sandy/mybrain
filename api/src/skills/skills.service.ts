import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';

/** Parse a SKILL.md's frontmatter for name + description. */
export function parseSkillMd(md: string): { name?: string; description?: string } {
  const m = (md || '').match(/^\s*---\s*([\s\S]*?)\s*---/);
  if (!m) return {};
  const fm = m[1];
  const name = (fm.match(/^name:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  const description = (fm.match(/^description:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  return { name: name || undefined, description: description || undefined };
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
  ) {}

  /** AI-write a short description of a skill from its SKILL.md (falls back to the given text). */
  async aiDescribe(content: string, fallback?: string): Promise<string> {
    const fb = (fallback || '').trim();
    if (!content?.trim()) return fb;
    const prompt =
      `In 1-2 plain sentences, describe what this Claude skill does and when it's useful. ` +
      `No preamble, no "This skill…", just the description.\n\nSKILL.md:\n${content.slice(0, 5000)}`;
    const text = await this.llm.complete(prompt, 200);
    return (text?.trim() || fb).slice(0, 600);
  }

  private shape(s: any) {
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      origin: s.origin,
      platform: s.platform,
      downloadUrl: s.downloadUrl,
      hasFile: !!s.filePath || !!s.content,
      inUse: s.inUse,
      installed: s.installed,
      lastUsedAt: s.lastUsedAt,
      usageCount: s.usageCount,
      shared: s.shared,
      createdAt: s.createdAt,
    };
  }

  async create(input: CreateInput) {
    const parsed = input.content ? parseSkillMd(input.content) : {};
    const title = (input.title?.trim() || parsed.name || 'Untitled skill').slice(0, 120);
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
    return rows.map((s) => this.shape(s));
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
    return { title: s.title, description: s.description, platform: s.platform, origin: s.origin, downloadUrl: s.downloadUrl, hasFile: !!s.filePath || !!s.content };
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

  async remove(id: string) {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return;
    await this.memory.deleteDoc(s.supermemoryId, s.ragId);
    if (s.filePath) await fs.unlink(s.filePath).catch(() => undefined);
    await this.prisma.skill.delete({ where: { id } });
  }
}
