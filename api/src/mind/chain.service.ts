import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';

// Cheap model for turning a plain sentence into a goal/blocker/lever chain.
const PARSE_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' };

/** The Situation model (BEA-515): the user's Goal → Blocker → Lever chains. */
@Injectable()
export class MindChainService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  private today() {
    return new Date().toISOString().slice(0, 10);
  }

  list() {
    return this.prisma.mindChain.findMany({
      where: { status: { not: 'retired' } },
      orderBy: [{ pinned: 'desc' }, { status: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async create(data: { goal?: string; blocker?: string; lever?: string; note?: string; source?: string }) {
    const goal = (data.goal || '').trim().slice(0, 200);
    const blocker = (data.blocker || '').trim().slice(0, 200);
    const lever = (data.lever || '').trim().slice(0, 200);
    if (!goal && !blocker && !lever) return null;
    const engine = data.source === 'engine';
    return this.prisma.mindChain.create({
      data: {
        goal,
        blocker,
        lever,
        note: data.note?.trim().slice(0, 400) || null,
        source: engine ? 'engine' : 'user',
        validated: engine ? null : 'confirmed', // a chain the user typed is theirs — already confirmed
        confidence: engine ? 0.6 : 0.85,
        firstSeenDay: this.today(),
        lastSeenDay: this.today(),
      },
    });
  }

  async update(id: string, patch: { goal?: string; blocker?: string; lever?: string; note?: string; status?: string }) {
    const data: Record<string, unknown> = { lastSeenDay: this.today() };
    for (const k of ['goal', 'blocker', 'lever'] as const) if (typeof patch[k] === 'string') data[k] = patch[k]!.trim().slice(0, 200);
    if (typeof patch.note === 'string') data.note = patch.note.trim().slice(0, 400) || null;
    if (patch.status && ['active', 'resolved', 'retired'].includes(patch.status)) data.status = patch.status;
    return this.prisma.mindChain.update({ where: { id }, data }).catch(() => null);
  }

  confirm(id: string) {
    return this.prisma.mindChain.update({ where: { id }, data: { validated: 'confirmed', confidence: 0.95, lastSeenDay: this.today() } }).catch(() => null);
  }
  refute(id: string) {
    return this.prisma.mindChain.update({ where: { id }, data: { validated: 'refuted', status: 'retired' } }).catch(() => null);
  }
  resolve(id: string) {
    return this.prisma.mindChain.update({ where: { id }, data: { status: 'resolved', lastSeenDay: this.today() } }).catch(() => null);
  }
  pin(id: string, pinned: boolean) {
    return this.prisma.mindChain.update({ where: { id }, data: { pinned } }).catch(() => null);
  }
  remove(id: string) {
    return this.prisma.mindChain.delete({ where: { id } }).catch(() => null);
  }

  /** Turn a plain sentence into {goal, blocker, lever} for the user to confirm. */
  async parse(text: string): Promise<{ goal: string; blocker: string; lever: string }> {
    const t = (text || '').trim();
    if (!t) return { goal: '', blocker: '', lever: '' };
    const prompt =
      `The user describes, in their own words, something that's blocking them. Turn it into a simple chain.\n` +
      `Return ONLY JSON: {"goal":"what they're trying to achieve","blocker":"what's stopping it","lever":"the ONE thing that would unblock it"}.\n` +
      `Keep each a short plain phrase. If a part isn't stated, make a concise best guess or use "".\n\nUSER:\n${t.slice(0, 800)}`;
    const raw = (await this.llm.completeWith(PARSE_MODEL, prompt, 300, 'chain-parse'))?.trim() || '';
    try {
      const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      return {
        goal: String(j?.goal || '').trim().slice(0, 200),
        blocker: String(j?.blocker || '').trim().slice(0, 200),
        lever: String(j?.lever || '').trim().slice(0, 200),
      };
    } catch {
      return { goal: '', blocker: '', lever: '' };
    }
  }

  /** Compact digest of active chains, for grounding the Mentor + Coach. (BEA-517) */
  async summaryForMentor(limit = 6): Promise<string> {
    const rows = await this.prisma.mindChain.findMany({
      where: { status: 'active', NOT: { validated: 'refuted' } },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    });
    if (!rows.length) return '';
    return rows.map((r) => `- Goal: ${r.goal}. Blocked by: ${r.blocker}. The lever: ${r.lever}.${r.note ? ` (${r.note})` : ''}`).join('\n');
  }
}
