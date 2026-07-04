import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Your ✓/✗/almost taps are the experiment that makes the model trustworthy. (BEA-449)
@Injectable()
export class MindReviewService {
  constructor(private readonly prisma: PrismaService) {}

  private today() {
    return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST day, not the UTC container day (BEA-813)
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

  /** 📝 — the user's own words on a finding: stored as feedback evidence + counts as a soft confirm. (BEA-464) */
  async note(id: string, text: string) {
    const body = (text || '').trim().slice(0, 600);
    if (!body) return { ok: false };
    const f = await this.prisma.mindFinding.findUnique({ where: { id } });
    if (!f) return { ok: false };
    await this.prisma.mindEvidence.create({ data: { findingId: id, sourceType: 'feedback', sourceId: null, day: this.today(), signal: 'feedback', snippet: body } });
    const conf = Math.min(0.99, f.confidence + (1 - f.confidence) * 0.2); // a note is a softer "yes" than ✓
    await this.prisma.mindFinding.update({
      where: { id },
      data: { validated: 'confirmed', confidence: conf, evidenceCount: f.evidenceCount + 1, lastSeenDay: this.today(), status: f.status === 'proposed' ? 'emerging' : f.status === 'fading' ? 'emerging' : f.status },
    });
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
