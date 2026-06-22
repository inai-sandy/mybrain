import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Scientist-grade analytics for The Lab dashboard (BEA-455): mood trend, what-moves-your-mood, heatmaps.
@Injectable()
export class MindStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async stats() {
    // ---- Mood time-series (last ~60 nightly stories) ----
    const dayStories = await this.prisma.dayStory.findMany({ orderBy: { day: 'desc' }, take: 60, select: { day: true, moodScore: true } });
    const moodSeries = dayStories
      .filter((d) => d.moodScore != null)
      .map((d) => ({ day: d.day, mood: d.moodScore as number }))
      .reverse();

    // ---- Mood by day-of-week (the weekly heatmap) ----
    const dow: Record<number, { sum: number; count: number }> = {};
    for (const d of dayStories) {
      if (d.moodScore == null) continue;
      const wd = new Date(d.day + 'T00:00:00').getDay();
      (dow[wd] ||= { sum: 0, count: 0 }).sum += d.moodScore;
      dow[wd].count++;
    }
    const dowMood = [0, 1, 2, 3, 4, 5, 6].map((wd) => ({ dow: wd, avg: dow[wd]?.count ? Math.round(dow[wd].sum / dow[wd].count) : null, n: dow[wd]?.count || 0 }));

    // ---- What moves your mood (from validated findings) ----
    const findings = await this.prisma.mindFinding.findMany({
      where: { status: { in: ['established', 'emerging'] }, NOT: { validated: 'refuted' } },
      orderBy: { confidence: 'desc' },
      take: 50,
      select: { subject: true, statement: true, valence: true, confidence: true, evidenceCount: true },
    });
    const mv = (f: (typeof findings)[number]) => ({ label: f.subject, statement: f.statement, strength: Math.round(f.confidence * 100), n: f.evidenceCount });
    const energizers = findings.filter((f) => f.valence === 'energizing').map(mv).slice(0, 10);
    const drainers = findings.filter((f) => f.valence === 'draining').map(mv).slice(0, 10);

    // ---- The avoidance map: do / defer by task category ----
    const tasks = await this.prisma.task.findMany({ select: { category: true, status: true, rolloverCount: true } });
    const cat: Record<string, { done: number; deferred: number; total: number }> = {};
    for (const t of tasks) {
      const c = (t.category || 'Uncategorized').trim() || 'Uncategorized';
      (cat[c] ||= { done: 0, deferred: 0, total: 0 }).total++;
      if (t.status === 'done') cat[c].done++;
      else if ((t.rolloverCount || 0) > 0) cat[c].deferred++;
    }
    const categories = Object.entries(cat)
      .map(([category, v]) => ({ category, ...v, avoidance: v.total ? Math.round((v.deferred / v.total) * 100) : 0 }))
      .filter((c) => c.total >= 2)
      .sort((a, b) => b.deferred - a.deferred || b.avoidance - a.avoidance)
      .slice(0, 12);

    return { moodSeries, dowMood, energizers, drainers, categories };
  }
}
