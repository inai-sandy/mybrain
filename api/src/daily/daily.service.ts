import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_TZ = 'Asia/Kolkata';

@Injectable()
export class DailyService {
  constructor(private readonly prisma: PrismaService) {}

  private async tz(): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'tasks.tz' } });
    return row?.value || DEFAULT_TZ;
  }

  /** Local day key (YYYY-MM-DD) in the user's timezone. */
  private dayKey(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }

  // ---- nightly story (one per day) ----

  async submitStory(rawText: string, source = 'app', mood?: string) {
    const text = (rawText || '').trim();
    if (!text) return null;
    const day = this.dayKey(await this.tz());
    const existing = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    const row = existing
      ? await this.prisma.story.update({ where: { id: existing.id }, data: { rawText: text, source, mood: mood ?? existing.mood } })
      : await this.prisma.story.create({ data: { day, rawText: text, source, mood: mood || null } });
    return this.shapeStory(row);
  }

  private shapeStory(s: any) {
    return { id: s.id, day: s.day, text: s.rawText, source: s.source, mood: s.mood, createdAt: s.createdAt, updatedAt: s.updatedAt };
  }

  // ---- daytime notes ----

  async addNote(text: string, source = 'app') {
    const t = (text || '').trim();
    if (!t) return null;
    const day = this.dayKey(await this.tz());
    const row = await this.prisma.dayNote.create({ data: { day, text: t.slice(0, 2000), source } });
    return { id: row.id, day: row.day, text: row.text, source: row.source, createdAt: row.createdAt };
  }

  async deleteNote(id: string) {
    await this.prisma.dayNote.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  /** Today's story + notes for the daily loop. */
  async today() {
    const day = this.dayKey(await this.tz());
    const story = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    const notes = await this.prisma.dayNote.findMany({ where: { day }, orderBy: { createdAt: 'desc' } });
    return {
      day,
      storyDone: !!story,
      story: story ? this.shapeStory(story) : null,
      notes: notes.map((n) => ({ id: n.id, text: n.text, source: n.source, createdAt: n.createdAt })),
    };
  }
}
