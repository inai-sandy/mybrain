import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Your ✓/✗/almost taps are the experiment that makes the model trustworthy. (BEA-449)
@Injectable()
export class MindReviewService {
  constructor(private readonly prisma: PrismaService) {}

  private today() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Everything the brain understood that you haven't judged yet, plus fading ones asking "still you?". */
  async review() {
    const pending = await this.prisma.mindFinding.findMany({
      where: { validated: null, status: { in: ['proposed', 'emerging', 'established'] } },
      orderBy: [{ confidence: 'desc' }],
      take: 100,
      include: { evidence: { take: 4, orderBy: { createdAt: 'desc' } } },
    });
    const fading = await this.prisma.mindFinding.findMany({
      where: { status: 'fading', pinned: false },
      orderBy: [{ confidence: 'asc' }],
      take: 20,
      include: { evidence: { take: 2, orderBy: { createdAt: 'desc' } } },
    });
    return { pending, fading };
  }

  /** ✓ — confirm: boost confidence, mark validated, and RIPPLE a small boost to related findings. */
  async confirm(id: string) {
    const f = await this.prisma.mindFinding.findUnique({ where: { id } });
    if (!f) return { ok: false };
    const conf = Math.min(0.99, f.confidence + (1 - f.confidence) * 0.35);
    const status = f.status === 'fading' ? 'established' : f.evidenceCount >= 3 && conf >= 0.55 ? 'established' : f.status === 'proposed' ? 'emerging' : f.status;
    await this.prisma.mindFinding.update({ where: { id }, data: { validated: 'confirmed', confidence: conf, status, trend: 'rising', lastSeenDay: this.today() } });
    // Ripple: nudge findings that share a node (subject or object) — confirmation of one supports its neighbours.
    await this.prisma.mindFinding
      .findMany({ where: { id: { not: id }, NOT: { status: 'retired' }, OR: [{ subject: f.subject }, { object: f.object }, { subject: f.object }, { object: f.subject }] }, take: 12 })
      .then((rel) => Promise.all(rel.map((r) => this.prisma.mindFinding.update({ where: { id: r.id }, data: { confidence: Math.min(0.97, r.confidence + 0.03) } }).catch(() => undefined))));
    return { ok: true, confidence: conf, status };
  }

  /** ✗ — refute: retire it AND record the boundary so the engine never re-proposes it. */
  async refute(id: string) {
    const f = await this.prisma.mindFinding.findUnique({ where: { id } });
    if (!f) return { ok: false };
    await this.prisma.mindFinding.update({ where: { id }, data: { validated: 'refuted', status: 'retired', confidence: 0, trend: 'fading' } });
    return { ok: true };
  }

  /** "almost" — amend the wording/nodes and treat it as a confirmation. */
  async amend(id: string, patch: { statement?: string; subject?: string; relation?: string; object?: string; valence?: string }) {
    const f = await this.prisma.mindFinding.findUnique({ where: { id } });
    if (!f) return { ok: false };
    const data: any = { validated: 'confirmed', confidence: Math.min(0.99, f.confidence + (1 - f.confidence) * 0.3) };
    for (const k of ['statement', 'subject', 'relation', 'object', 'valence'] as const) if (typeof patch[k] === 'string' && patch[k]!.trim()) data[k] = patch[k]!.trim().slice(0, 400);
    await this.prisma.mindFinding.update({ where: { id }, data });
    return { ok: true };
  }

  async pin(id: string, pinned: boolean) {
    await this.prisma.mindFinding.update({ where: { id }, data: { pinned } }).catch(() => undefined);
    return { ok: true, pinned };
  }

  async remove(id: string) {
    await this.prisma.mindFinding.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  }
}
