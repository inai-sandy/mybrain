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
      `Return ONLY JSON: {"goal":"what they're trying to achieve","blocker":"what's stopping it","lever":"the ONE next-action that would unblock it"}.\n` +
      `Keep goal and blocker short plain phrases. Write the LEVER as a tiny if-then plan anchored to an everyday cue: "When <a daily cue like after my morning coffee / after lunch / before I leave work>, I'll <one concrete action>." Pick a cue that fits; keep it one action, not a plan.\n` +
      `If a part isn't stated, make a concise best guess or use "".\n\nUSER:\n${t.slice(0, 800)}`;
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

  // Cheap normalisation for de-duping proposed chains against what already exists.
  private norm(s: string): string {
    return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }
  private overlap(a: string, b: string): boolean {
    const wa = new Set(this.norm(a).split(' ').filter((w) => w.length > 3));
    const wb = new Set(this.norm(b).split(' ').filter((w) => w.length > 3));
    if (!wa.size || !wb.size) return false;
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter++;
    return inter / Math.min(wa.size, wb.size) >= 0.5;
  }

  /** Propose Goal→Blocker→Lever chains from a day's signals + the user's own words. Saved as source='engine'. (BEA-516) */
  async inferFromDay(day: string): Promise<number> {
    const [tasks, story, drains, aboutRow, existing, notes] = await Promise.all([
      this.prisma.task.findMany({ where: { day }, select: { title: true, status: true, category: true, rolloverCount: true } }),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' }, select: { rawText: true } }),
      this.prisma.mindFinding.findMany({ where: { status: { in: ['emerging', 'established'] }, valence: 'draining', NOT: { validated: 'refuted' } }, orderBy: { confidence: 'desc' }, take: 8, select: { statement: true } }),
      this.prisma.setting.findUnique({ where: { key: 'mind.aboutMe' } }),
      this.prisma.mindChain.findMany({ where: { status: { not: 'retired' } }, select: { goal: true, blocker: true } }),
      this.prisma.mindEvidence.findMany({ where: { signal: 'feedback' }, orderBy: { createdAt: 'desc' }, take: 12, select: { snippet: true } }),
    ]);
    const deferred = tasks.filter((t) => (t.rolloverCount || 0) > 0 && t.status !== 'done');
    if (!deferred.length && !(story?.rawText || '').trim()) return 0; // nothing to reason from

    const prompt =
      `You build a map of someone's SITUATION as chains: a GOAL, what's BLOCKING it, and the one LEVER that would unblock it.\n` +
      `Only propose a chain when the evidence genuinely points to an underlying blocker (e.g. a kind of task is repeatedly deferred AND there's a reason for it). Be conservative — 0–2 chains. Plain words.\n` +
      `Write each LEVER as a tiny if-then plan anchored to an everyday cue: "When <a daily cue like after my morning coffee / after lunch / before I leave work>, I'll <one concrete action>." One action, not a plan.\n\n` +
      (aboutRow?.value ? `WHO THEY ARE (their words):\n${aboutRow.value.slice(0, 800)}\n\n` : '') +
      (deferred.length ? `REPEATEDLY DEFERRED TASKS:\n${deferred.map((t) => `- ${t.title}${t.category ? ` [${t.category}]` : ''} (deferred ${t.rolloverCount}×)`).join('\n')}\n\n` : '') +
      (drains.length ? `DRAINING PATTERNS:\n${drains.map((d) => `- ${d.statement}`).join('\n')}\n\n` : '') +
      (notes.length ? `THEIR OWN NOTES:\n${notes.map((n) => `- ${n.snippet}`).join('\n')}\n\n` : '') +
      (story?.rawText ? `TODAY'S STORY:\n${story.rawText.slice(0, 1500)}\n\n` : '') +
      `Return ONLY JSON: {"chains":[{"goal":"...","blocker":"...","lever":"..."}]} (empty array if nothing well-grounded).`;
    const raw = (await this.llm.completeWith(PARSE_MODEL, prompt, 600, 'chain-infer'))?.trim() || '';
    let list: { goal?: string; blocker?: string; lever?: string }[] = [];
    try {
      const jjson = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (Array.isArray(jjson?.chains)) list = jjson.chains;
    } catch {
      list = [];
    }
    let created = 0;
    for (const c of list.slice(0, 2)) {
      const goal = String(c?.goal || '').trim();
      const blocker = String(c?.blocker || '').trim();
      const lever = String(c?.lever || '').trim();
      if (!goal || !blocker) continue;
      const dup = existing.some((e) => this.overlap(e.blocker, blocker) || (this.overlap(e.goal, goal) && this.overlap(e.blocker, blocker)));
      if (dup) continue;
      await this.create({ goal, blocker, lever, source: 'engine' });
      existing.push({ goal, blocker }); // so two proposals this run don't duplicate each other
      created++;
    }
    return created;
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
