import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { EnrichmentService } from './enrichment.service';
import { NotionService } from './notion.service';

function itemsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'items');
}

/** Merge tag lists: lowercase, trim, dedupe, manual first, cap at 8. */
export function mergeTags(manual: string[] = [], generated: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...manual, ...generated]) {
    const v = String(t || '').toLowerCase().trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.slice(0, 8);
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly enrichment: EnrichmentService,
    private readonly notion: NotionService,
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
    const words = (title + ' ' + content.slice(0, 600)).toLowerCase().match(/[a-z]{4,14}/g) || [];
    const stop = new Set(['this', 'that', 'with', 'from', 'your', 'have', 'will', 'about', 'into', 'they', 'them', 'were', 'what', 'when', 'then', 'than', 'also', 'gitignore']);
    const freq: Record<string, number> = {};
    // skip random-looking tokens (no vowel) so junk like "nirgxlxruu" doesn't become a tag.
    const looksWord = (w: string) => /[aeiou]/.test(w);
    for (const w of words) if (!stop.has(w) && looksWord(w)) freq[w] = (freq[w] || 0) + 1;
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);
  }

  /** Store markdown: dedup by content hash + source; file is the source of truth; enqueue dual-write. */
  async store(content: string, source: string, title?: string, sourceUrl?: string, manualTags: string[] = []) {
    const contentHash = this.hash(content);
    const existing = await this.prisma.item.findUnique({
      where: { contentHash_source: { contentHash, source } },
    });
    if (existing) return { item: existing, deduped: true };

    const finalTitle = title?.trim() || this.titleFrom(content, source);
    // AI summary + tags via Haiku; fall back to the keyword heuristic.
    const enriched = await this.enrichment.enrich(finalTitle, content);
    const generated = enriched?.tags?.length ? enriched.tags : this.suggestTags(finalTitle, content);
    const tags = mergeTags(manualTags, generated);
    const summary = enriched?.summary || null;
    const item = await this.prisma.item.create({
      data: { contentHash, source, title: finalTitle, summary, tags: JSON.stringify(tags), sourceUrl: sourceUrl || null },
    });

    const dir = itemsDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = join(dir, `${item.id}.md`);
    await fs.writeFile(filePath, content, 'utf8');
    await this.prisma.item.update({ where: { id: item.id }, data: { filePath } });

    await this.memory.enqueue(content, { itemId: item.id, title: finalTitle, tags });
    return { item: { ...item, filePath }, deduped: false };
  }

  /** Reclassify a captured item as a bookmark so it shows on the Bookmarks page + bookmark chat-scope. */
  async setBookmark(id: string) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item) return null;
    let tags: string[] = [];
    try {
      tags = item.tags ? JSON.parse(item.tags) : [];
    } catch {
      /* ignore */
    }
    if (!tags.includes('bookmark')) tags.push('bookmark');
    await this.prisma.item.update({ where: { id }, data: { source: 'bookmark', tags: JSON.stringify(tags) } });
    // Re-index with the bookmark tag so the "Bookmarks" chat scope can find it.
    const content = item.filePath ? await fs.readFile(item.filePath, 'utf8').catch(() => item.summary || item.title || '') : item.summary || item.title || '';
    await this.memory.enqueue(content, { itemId: id, title: item.title || undefined, tags }).catch(() => undefined);
    return { ok: true };
  }

  async list() {
    // Bookmarks (raindrop or manually bookmarked) live on the Bookmarks page — keep them out of the documents list.
    const items = await this.prisma.item.findMany({ where: { source: { notIn: ['raindrop', 'bookmark'] } }, orderBy: { createdAt: 'desc' }, take: 200 });
    return items.map((i) => {
      const supermemory = !!i.supermemoryId;
      const rag = !!i.ragId;
      return {
        id: i.id,
        title: i.title,
        source: i.source,
        tags: i.tags ? JSON.parse(i.tags) : [],
        summary: i.summary,
        createdAt: i.createdAt,
        sourceUrl: i.sourceUrl,
        supermemory,
        rag,
        chunked: supermemory, // SuperMemory chunks server-side
        memoryStatus: supermemory && rag ? 'synced' : 'pending',
        shared: i.shared,
      };
    });
  }

  /** Publish/unpublish an item as a public share. */
  async setShared(id: string, shared: boolean) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item) return null;
    await this.prisma.item.update({ where: { id }, data: { shared } });
    return { shared };
  }

  /** Public read: content + meta, ONLY if the item is shared. */
  async getShared(id: string) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item || !item.shared) return null;
    const content = item.filePath ? await fs.readFile(item.filePath, 'utf8').catch(() => '') : '';
    return { title: item.title, summary: item.summary, source: item.source, sourceUrl: item.sourceUrl, thumbnail: item.thumbnail, content };
  }

  /** Return a stored item's markdown content + meta. */
  async getContent(id: string) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item || !item.filePath) return null;
    const content = await fs.readFile(item.filePath, 'utf8').catch(() => null);
    if (content == null) return null;
    return { title: item.title, summary: item.summary, source: item.source, sourceUrl: item.sourceUrl, content };
  }

  /** Permanent delete: flush both memory stores, remove the file, delete the row. */
  async remove(id: string) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item) return;
    // Cancel any pending memory writes for this item so nothing lands after delete.
    await this.prisma.memoryOutbox.deleteMany({ where: { itemId: id } }).catch(() => undefined);
    await this.memory.deleteDoc(item.supermemoryId, item.ragId);
    if (item.filePath) await fs.unlink(item.filePath).catch(() => undefined);
    await this.prisma.item.delete({ where: { id } });
  }

  /** Import the user's SuperMemory documents as app items (linked to the existing SM entry; no re-write). */
  async importFromSuperMemory() {
    const { docs } = await this.memory.browseSuperMemory(500, 1);
    const existing = await this.prisma.item.findMany({ where: { supermemoryId: { not: null } }, select: { supermemoryId: true } });
    const have = new Set(existing.map((e) => e.supermemoryId));
    const dir = itemsDir();
    await fs.mkdir(dir, { recursive: true });

    let imported = 0;
    let skipped = 0;
    for (const sm of docs) {
      if (have.has(sm.id)) {
        skipped++;
        continue;
      }
      // App-generated entries (bookmarks, ideas) are written to SuperMemory by us — never round-trip them
      // back in as documents, or each sync would create duplicates.
      if (['idea', 'bookmark', 'skill', 'task', 'story', 'activity'].some((t) => (sm.tags || []).includes(t))) {
        skipped++;
        continue;
      }
      const full = await this.memory.getSuperMemoryContent(sm.id);
      if (!full || !full.content.trim()) {
        skipped++;
        continue;
      }
      const title = (full.title || sm.title || 'Untitled').slice(0, 200);
      const tags = full.tags?.length ? full.tags : sm.tags || [];
      const item = await this.prisma.item
        .create({
          data: {
            contentHash: this.hash(full.content),
            source: 'supermemory',
            title,
            summary: sm.summary || full.summary || null,
            tags: JSON.stringify(tags),
            supermemoryId: sm.id, // already in SuperMemory → S✓, no re-write
          },
        })
        .catch(() => null);
      if (!item) {
        skipped++;
        continue;
      }
      const filePath = join(dir, `${item.id}.md`);
      await fs.writeFile(filePath, full.content, 'utf8');
      await this.prisma.item.update({ where: { id: item.id }, data: { filePath } });
      imported++;
    }
    const lastSync = new Date().toISOString();
    await this.prisma.setting
      .upsert({ where: { key: 'supermemory.lastSync' }, create: { key: 'supermemory.lastSync', value: lastSync }, update: { value: lastSync } })
      .catch(() => undefined);
    return { imported, skipped, total: docs.length, lastSync };
  }

  async lastSuperMemorySync(): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'supermemory.lastSync' } });
    return row?.value || null;
  }

  /** Re-fetch the latest content from the source and refresh both memory stores. */
  async sync(id: string) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item) return null;

    let content: string | null = null;
    if (item.source === 'url' && item.sourceUrl) {
      content = await fetch(item.sourceUrl).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    } else if (item.source === 'notion' && item.sourceUrl) {
      content = await this.notion.fetchMarkdown(item.sourceUrl).then((d) => d.markdown).catch(() => null);
    } else if (item.filePath) {
      content = await fs.readFile(item.filePath, 'utf8').catch(() => null); // upload: re-index current content
    }
    if (!content || !content.trim()) return { ok: false, reason: 'Could not fetch the latest content' };

    // flush old memory, refresh file + hash, re-write to both stores
    await this.memory.deleteDoc(item.supermemoryId, item.ragId);
    const dir = itemsDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = item.filePath || join(dir, `${item.id}.md`);
    await fs.writeFile(filePath, content, 'utf8');
    await this.prisma.item.update({
      where: { id },
      data: { contentHash: this.hash(content), filePath, supermemoryId: null, ragId: null },
    });
    await this.memory.enqueue(content, { itemId: id, title: item.title || undefined, tags: item.tags ? JSON.parse(item.tags) : [] });
    return { ok: true };
  }

  /** Full detail for the document page. */
  async getDetail(id: string) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item) return null;
    const content = item.filePath ? await fs.readFile(item.filePath, 'utf8').catch(() => '') : '';
    let idea: { id: string; title: string } | null = null;
    if (item.ideaId) {
      const i = await this.prisma.idea.findUnique({ where: { id: item.ideaId }, select: { id: true, title: true } });
      if (i) idea = { id: i.id, title: i.title };
    }
    return {
      id: item.id,
      title: item.title,
      summary: item.summary,
      source: item.source,
      sourceUrl: item.sourceUrl,
      tags: item.tags ? JSON.parse(item.tags) : [],
      createdAt: item.createdAt,
      supermemory: !!item.supermemoryId,
      rag: !!item.ragId,
      chunked: !!item.supermemoryId,
      shared: item.shared,
      thumbnail: item.thumbnail,
      ideaId: item.ideaId,
      idea,
      content,
    };
  }
}
