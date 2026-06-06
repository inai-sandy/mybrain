import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';

function itemsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'items');
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
  ) {}

  private hash(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  private titleFrom(content: string, fallback: string): string {
    const m = content.match(/^#\s+(.+)$/m);
    return (m?.[1] || fallback || 'Untitled').trim().slice(0, 200);
  }

  /** Cheap tag suggestion from the title + opening text. */
  private suggestTags(title: string, content: string): string[] {
    const words = (title + ' ' + content.slice(0, 600)).toLowerCase().match(/[a-z]{4,}/g) || [];
    const stop = new Set(['this', 'that', 'with', 'from', 'your', 'have', 'will', 'about', 'into', 'they', 'them', 'were', 'what', 'when', 'then', 'than', 'also']);
    const freq: Record<string, number> = {};
    for (const w of words) if (!stop.has(w)) freq[w] = (freq[w] || 0) + 1;
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);
  }

  /** Store markdown: dedup by content hash + source; file is the source of truth; enqueue dual-write. */
  async store(content: string, source: string, title?: string) {
    const contentHash = this.hash(content);
    const existing = await this.prisma.item.findUnique({
      where: { contentHash_source: { contentHash, source } },
    });
    if (existing) return { item: existing, deduped: true };

    const finalTitle = title?.trim() || this.titleFrom(content, source);
    const tags = this.suggestTags(finalTitle, content);
    const item = await this.prisma.item.create({
      data: { contentHash, source, title: finalTitle, tags: JSON.stringify(tags) },
    });

    const dir = itemsDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = join(dir, `${item.id}.md`);
    await fs.writeFile(filePath, content, 'utf8');
    await this.prisma.item.update({ where: { id: item.id }, data: { filePath } });

    await this.memory.enqueue(content, { itemId: item.id, title: finalTitle, tags });
    return { item: { ...item, filePath }, deduped: false };
  }

  async list() {
    const items = await this.prisma.item.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    return items.map((i) => {
      const supermemory = !!i.supermemoryId;
      const rag = !!i.ragId;
      return {
        id: i.id,
        title: i.title,
        source: i.source,
        tags: i.tags ? JSON.parse(i.tags) : [],
        createdAt: i.createdAt,
        supermemory,
        rag,
        chunked: supermemory, // SuperMemory chunks server-side
        memoryStatus: supermemory && rag ? 'synced' : 'pending',
      };
    });
  }

  async remove(id: string) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item) return;
    if (item.filePath) await fs.unlink(item.filePath).catch(() => undefined);
    await this.prisma.item.delete({ where: { id } });
  }
}
