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
        minutesSpent: dash.minutesSpent,
        daySummary: activity.summary?.text ? activity.summary.text.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
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
