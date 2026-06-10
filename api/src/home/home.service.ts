import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { DailyService } from '../daily/daily.service';

@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly daily: DailyService,
  ) {}

  /** Everything the Home command-center needs, in one call. */
  async summary() {
    const [today, dailyToday, dash, activity, personality] = await Promise.all([
      this.tasks.today(),
      this.daily.today(),
      this.daily.dashboard(30),
      this.daily.activity(),
      this.daily.getPersonality(),
    ]);

    const [documents, bookmarks, ideas, skills] = await Promise.all([
      this.prisma.item.count({ where: { source: { not: 'raindrop' } } }),
      this.prisma.item.count({ where: { source: 'raindrop' } }),
      this.prisma.idea.count(),
      this.prisma.skill.count(),
    ]);

    const recentRows = await this.prisma.item.findMany({
      where: { source: { not: 'raindrop' } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, title: true, source: true, createdAt: true },
    });

    const mustDos = (today.tasks || []).filter((t: any) => t.status === 'open').slice(0, 3);

    // Day summary: today's once it exists (after 9:30 PM), otherwise yesterday's — mornings shouldn't show an empty card.
    let summaryText: string | null = activity.summary?.text || null;
    let summaryFor: 'today' | 'yesterday' | null = summaryText ? 'today' : null;
    if (!summaryText && activity.day) {
      const y = new Date(activity.day + 'T12:00:00Z');
      y.setUTCDate(y.getUTCDate() - 1);
      const row = await this.prisma.daySummary.findUnique({ where: { day: y.toISOString().slice(0, 10) } });
      if (row?.text) {
        summaryText = row.text;
        summaryFor = 'yesterday';
      }
    }

    return {
      today: {
        dumped: today.dumped,
        storyDone: dailyToday.storyDone,
        counts: today.counts,
        mustDos,
      },
      insights: {
        streak: dash.streak,
        followThrough: dash.totals.followThrough,
        followTrend: dash.followTrend,
        minutesSpent: dash.minutesSpent,
        minutesToday: activity.stats?.minutesSpent ?? 0,
        daySummary: summaryText ? summaryText.replace(/\s+/g, ' ').trim().slice(0, 280) : null,
        daySummaryFor: summaryFor,
      },
      personality: {
        unlocked: personality.unlocked,
        summary: personality.summary,
        daysCovered: personality.daysCovered,
        minDays: personality.minDays,
      },
      counts: { documents, bookmarks, ideas, skills },
      recent: recentRows.map((r) => ({ id: r.id, title: r.title || 'Untitled', source: r.source, createdAt: r.createdAt })),
    };
  }
}
