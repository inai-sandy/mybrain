import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';

const SCORE_MIN = 0.48; // conservative — only confident links
const MIN_CROSS = 2; // need a real cross-type cluster, not a single near-match
const MAX_ANCHORS = 15;
const MAX_PER_RUN = 8;
const DISCOVER_MS = 6 * 60 * 60 * 1000; // every 6h

const TYPE_LABEL: Record<string, string> = { item: 'document', idea: 'idea', meeting: 'meeting', note: 'note', task: 'task', story: 'story', daystory: 'story', daysummary: 'day', gmailbrief: 'email brief', gmailrequest: 'email' };

function linkFor(type: string, id: string, day?: string): string {
  switch (type) {
    case 'item': return `/doc/${id}`;
    case 'idea': return `/ideas/${id}`;
    case 'meeting': return `/meeting/${id}`;
    case 'note': return '/notes';
    case 'task': return '/tasks';
    case 'story':
    case 'daystory':
    case 'daysummary': return day ? `/activity?day=${day}` : '/activity';
    case 'gmailbrief':
    case 'gmailrequest': return '/google/gmail';
    default: return '/explore';
  }
}
function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

@Injectable()
export class ConnectionsService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
  ) {}

  onModuleInit() {
    // First pass shortly after boot, then every 6h.
    setTimeout(() => this.discover().catch(() => undefined), 90_000);
    this.timer = setInterval(() => this.discover().catch(() => undefined), DISCOVER_MS);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async list(status = 'active') {
    const where = status === 'all' ? {} : status === 'dismissed' ? { status: 'dismissed' } : { status: { not: 'dismissed' } };
    const rows = await this.prisma.connection.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r) => ({ id: r.id, summary: r.summary, items: safeParse(r.items), score: r.score, status: r.status, createdAt: r.createdAt }));
  }
  async dismiss(id: string) {
    await this.prisma.connection.update({ where: { id }, data: { status: 'dismissed' } }).catch(() => undefined);
    return { ok: true };
  }
  async markSeen(ids: string[]) {
    if (ids?.length) await this.prisma.connection.updateMany({ where: { id: { in: ids }, status: 'new' }, data: { status: 'seen' } }).catch(() => undefined);
    return { ok: true };
  }

  /** Find non-obvious cross-type links among recently-active content. Conservative + de-duped. (BEA-357) */
  async discover(): Promise<{ found: number }> {
    const since = new Date(Date.now() - 21 * 86_400_000);
    const [items, ideas, tasks, meetings] = await Promise.all([
      this.prisma.item.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 12 }),
      this.prisma.idea.findMany({ orderBy: { createdAt: 'desc' }, take: 6 }),
      this.prisma.task.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.prisma.meeting.findMany({ where: { savedToMemory: true }, orderBy: { createdAt: 'desc' }, take: 4 }),
    ]);
    const anchors = [
      ...items.map((i) => ({ type: 'item', id: i.id, title: i.title || 'Document', text: i.summary || i.title || '' })),
      ...ideas.map((i) => ({ type: 'idea', id: i.id, title: i.title, text: i.content || i.title || '' })),
      ...meetings.map((m) => ({ type: 'meeting', id: m.id, title: m.title, text: m.summary || m.title || '' })),
      ...tasks.map((t) => ({ type: 'task', id: t.id, title: t.title, text: t.note || t.title || '' })),
    ].slice(0, MAX_ANCHORS);

    const existing = await this.prisma.connection.findMany({ where: { status: { not: 'dismissed' } }, select: { anchorKey: true } });
    const seenKeys = new Set(existing.map((e) => e.anchorKey));

    let found = 0;
    for (const a of anchors) {
      if (found >= MAX_PER_RUN) break;
      const key = `${a.type}:${a.id}`;
      if (seenKeys.has(key)) continue;
      const q = `${a.title} ${a.text}`.slice(0, 300).trim();
      if (!q) continue;
      const hits = await this.memory.searchBrain(q, 10).catch(() => []);
      const resolved = await this.memory.resolveRefs(hits.map((h) => h.memId).filter(Boolean) as string[]);
      const related: { type: string; id: string; title: string; link: string }[] = [];
      const usedIds = new Set([a.id]);
      let topScore = 0;
      for (const h of hits) {
        if ((h.score ?? 0) < SCORE_MIN) continue;
        const ent = h.memId ? resolved[h.memId] : undefined;
        if (!ent || (ent.type === a.type && ent.id === a.id) || usedIds.has(ent.id)) continue;
        usedIds.add(ent.id);
        topScore = Math.max(topScore, h.score ?? 0);
        related.push({ type: ent.type, id: ent.id, title: (h.title || '').slice(0, 80) || TYPE_LABEL[ent.type] || ent.type, link: linkFor(ent.type, ent.id, ent.day) });
        if (related.length >= 4) break;
      }
      if (related.filter((r) => r.type !== a.type).length < MIN_CROSS) continue; // require real cross-type breadth
      const anchorRef = { type: a.type, id: a.id, title: a.title, link: linkFor(a.type, a.id) };
      const summary = `Your ${TYPE_LABEL[a.type] || a.type} “${a.title}” connects to ${related.map((r) => `“${r.title}”`).join(', ')}`.slice(0, 600);
      await this.prisma.connection.create({ data: { summary, items: JSON.stringify([anchorRef, ...related]), score: topScore, status: 'new', anchorKey: key } });
      seenKeys.add(key);
      found++;
    }
    return { found };
  }
}
