import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// How long a finding may go without fresh evidence before it starts to decay — by its OWN rhythm.
// A weekly pattern shouldn't decay on a Tuesday; a daily one should be re-seen often.
function graceDays(cadence: string | null): number {
  switch (cadence) {
    case 'daily':
      return 3;
    case 'weekly':
      return 10;
    case 'situational':
      return 35;
    default:
      return 16;
  }
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00').getTime();
  const db = new Date(b + 'T00:00:00').getTime();
  return Math.round((da - db) / 86_400_000);
}
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * The "living" mechanics (BEA-448): rhythm-aware decay, emerging→established promotion, fading→retired,
 * and structural consolidation of duplicate findings. Pure, deterministic, well-tested — runs daily.
 */
@Injectable()
export class MindLifecycleService {
  private readonly log = new Logger('MindLifecycleService');

  constructor(private readonly prisma: PrismaService) {}

  /** Daily pass: consolidate duplicates, then decay/promote/retire. */
  async runDaily(today: string): Promise<{ merged: number; decayed: number; promoted: number; retired: number }> {
    const merged = await this.consolidate();
    const stepped = await this.decayAndPromote(today);
    if (merged || stepped.decayed || stepped.promoted || stepped.retired) {
      this.log.log(`mind lifecycle ${today}: merged ${merged}, decayed ${stepped.decayed}, promoted ${stepped.promoted}, retired ${stepped.retired}`);
    }
    return { merged, ...stepped };
  }

  /** Rhythm-aware decay + emerging→established + fading→retired. Pinned findings are immune to decay. */
  async decayAndPromote(today: string): Promise<{ decayed: number; promoted: number; retired: number }> {
    const rows = await this.prisma.mindFinding.findMany({ where: { NOT: { status: 'retired' } } });
    let decayed = 0;
    let promoted = 0;
    let retired = 0;
    for (const f of rows) {
      let confidence = f.confidence;
      let status = f.status;
      let trend = f.trend;

      if (!f.pinned) {
        const overdueBy = daysBetween(today, f.lastSeenDay) - graceDays(f.cadence);
        if (overdueBy > 0) {
          // Lose ~12% per day overdue (compounding), so a long-unseen finding fades on its own rhythm.
          confidence = Math.max(0, confidence * Math.pow(0.88, Math.min(overdueBy, 30)));
          trend = 'fading';
          decayed++;
        } else {
          trend = trend === 'rising' ? 'rising' : 'steady';
        }
      }

      // Promote a well-evidenced, durable finding to "established".
      const spanDays = daysBetween(f.lastSeenDay, f.firstSeenDay);
      if (['proposed', 'emerging'].includes(status) && f.evidenceCount >= 3 && confidence >= 0.55 && spanDays >= 6) {
        status = 'established';
        promoted++;
      } else if (status === 'proposed' && confidence >= 0.4) {
        status = 'emerging';
      }

      // Fade then retire at the floor (the "still you?" prompt surfaces fading ones for the user).
      if (!f.pinned) {
        if (confidence < 0.04) {
          status = 'retired';
          retired++;
        } else if (confidence < 0.13 && status !== 'retired') {
          status = 'fading';
        }
      }

      if (confidence !== f.confidence || status !== f.status || trend !== f.trend) {
        await this.prisma.mindFinding.update({ where: { id: f.id }, data: { confidence, status, trend } }).catch(() => undefined);
      }
    }
    return { decayed, promoted, retired };
  }

  /** Merge findings that assert the same subject–relation–object: combine evidence + take the strongest. */
  async consolidate(): Promise<number> {
    const rows = await this.prisma.mindFinding.findMany({ where: { NOT: { status: 'retired' } }, orderBy: { confidence: 'desc' } });
    const byKey = new Map<string, typeof rows[number]>();
    let merged = 0;
    for (const f of rows) {
      const key = `${norm(f.subject)}|${norm(f.relation)}|${norm(f.object)}`;
      const primary = byKey.get(key);
      if (!primary) {
        byKey.set(key, f);
        continue;
      }
      // Fold f into primary (primary has >= confidence since rows are confidence-desc).
      await this.prisma.mindEvidence.updateMany({ where: { findingId: f.id }, data: { findingId: primary.id } }).catch(() => undefined);
      await this.prisma.mindFinding.update({
        where: { id: primary.id },
        data: {
          evidenceCount: primary.evidenceCount + f.evidenceCount,
          confidence: Math.max(primary.confidence, f.confidence),
          firstSeenDay: primary.firstSeenDay < f.firstSeenDay ? primary.firstSeenDay : f.firstSeenDay,
          lastSeenDay: primary.lastSeenDay > f.lastSeenDay ? primary.lastSeenDay : f.lastSeenDay,
          pinned: primary.pinned || f.pinned,
        },
      }).catch(() => undefined);
      await this.prisma.mindFinding.delete({ where: { id: f.id } }).catch(() => undefined);
      primary.evidenceCount += f.evidenceCount;
      merged++;
    }
    return merged;
  }
}
