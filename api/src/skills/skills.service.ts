import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';

/** Parse a SKILL.md's frontmatter for name + description. */
export function parseSkillMd(md: string): { name?: string; description?: string } {
  const m = (md || '').match(/^\s*---\s*([\s\S]*?)\s*---/);
  if (!m) return {};
  const fm = m[1];
  const name = (fm.match(/^name:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  const description = (fm.match(/^description:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  return { name: name || undefined, description: description || undefined };
}

type CreateInput = { title?: string; description?: string; content?: string; origin?: string; platform?: string; downloadUrl?: string };

@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
  ) {}

  private shape(s: any) {
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      origin: s.origin,
      platform: s.platform,
      downloadUrl: s.downloadUrl,
      hasFile: !!s.content || !!s.filePath,
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
    const description = (input.description?.trim() || parsed.description || '').slice(0, 2000);
    const origin = input.origin === 'downloaded' ? 'downloaded' : 'created';
    const platform = input.platform === 'chat' ? 'chat' : 'code';
    const skill = await this.prisma.skill.create({
      data: { title, description, content: input.content || null, origin, platform, downloadUrl: input.downloadUrl?.trim() || null },
    });
    // Index the skill, stamped with the NEW non-overlapping tag "skill".
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

  async remove(id: string) {
    const s = await this.prisma.skill.findUnique({ where: { id } });
    if (!s) return;
    await this.memory.deleteDoc(s.supermemoryId, s.ragId);
    await this.prisma.skill.delete({ where: { id } });
  }
}
