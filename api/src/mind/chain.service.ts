import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { TasksService } from '../tasks/tasks.service';
import { PromptsService } from '../prompts/prompts.service';

// Cheap model for turning a plain sentence into a goal/blocker/lever chain.
const PARSE_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' };

/** The Situation model (BEA-515): the user's Goal → Blocker → Lever chains. */
@Injectable()
export class MindChainService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: TasksService,
    private readonly prompts: PromptsService,
  ) {}

  private today() {
    return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST day, not the UTC container day (BEA-813)
  }

  list() {
    return this.prisma.mindChain.findMany({
      where: { status: { not: 'retired' } },
      orderBy: [{ pinned: 'desc' }, { status: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async create(data: { goal?: string; blocker?: string; lever?: string; note?: string; source?: string; provenance?: string }) {
    const goal = (data.goal || '').trim().slice(0, 200);
    const blocker = (data.blocker || '').trim().slice(0, 200);
    const lever = (data.lever || '').trim().slice(0, 200);
    if (!goal && !blocker && !lever) return null;
    const engine = data.source === 'engine';

    // De-dupe the USER path: if a near-duplicate situation already exists, reinforce it instead of stacking
    // another card. (The engine path already de-dupes before calling create.) (BEA-542)
    if (!engine) {
      const active = await this.prisma.mindChain.findMany({ where: { status: { not: 'retired' } } });
      const dup = active.find((e) => this.isDup({ goal, blocker }, e));
      if (dup) {
        const reinforced = await this.prisma.mindChain.update({
          where: { id: dup.id },
          data: {
            validated: 'confirmed',
            confidence: Math.min(0.95, (dup.confidence || 0.7) + 0.1),
            lever: dup.lever || lever, // keep the user's lever if the old one was blank
            lastSeenDay: this.today(),
            shifted: false,
          },
        });
        return { ...reinforced, reinforced: true };
      }
    }

    return this.prisma.mindChain.create({
      data: {
        goal,
        blocker,
        lever,
        note: data.note?.trim().slice(0, 400) || null,
        provenance: (data.provenance || (engine ? null : `You added this · ${this.today()}`))?.slice(0, 300) || null,
        source: engine ? 'engine' : 'user',
        validated: engine ? null : 'confirmed', // a chain the user typed is theirs — already confirmed
        confidence: engine ? 0.6 : 0.85,
        firstSeenDay: this.today(),
        lastSeenDay: this.today(),
      },
    });
  }

  /** Two chains are "the same situation" if their blockers overlap, or both goal AND blocker overlap. */
  private isDup(a: { goal: string; blocker: string }, b: { goal: string; blocker: string }): boolean {
    return this.overlap(a.blocker, b.blocker) || (this.overlap(a.goal, b.goal) && this.overlap(a.blocker, b.blocker));
  }

  /** Merge near-duplicate active chains into the strongest one (keep best, retire the rest). (BEA-542) */
  async dedupeChains(): Promise<{ merged: number }> {
    const rows = await this.prisma.mindChain.findMany({ where: { status: { not: 'retired' } } });
    const score = (c: any) => (c.validated === 'confirmed' ? 2000 : c.validated === 'refuted' ? -1000 : 0) + (c.pinned ? 500 : 0) + (c.confidence || 0) * 100;
    const sorted = [...rows].sort((a, b) => score(b) - score(a));
    const kept: typeof rows = [];
    const retire: string[] = [];
    for (const c of sorted) {
      if (kept.find((k) => this.isDup(c, k))) retire.push(c.id);
      else kept.push(c);
    }
    if (retire.length) await this.prisma.mindChain.updateMany({ where: { id: { in: retire } }, data: { status: 'retired' } });
    return { merged: retire.length };
  }

  async update(id: string, patch: { goal?: string; blocker?: string; lever?: string; note?: string; status?: string }) {
    const data: Record<string, unknown> = { lastSeenDay: this.today(), shifted: false }; // the user touched it → no longer needs a "did it shift?" look
    for (const k of ['goal', 'blocker', 'lever'] as const) if (typeof patch[k] === 'string') data[k] = patch[k]!.trim().slice(0, 200);
    if (typeof patch.note === 'string') data.note = patch.note.trim().slice(0, 400) || null;
    if (patch.status && ['active', 'resolved', 'retired'].includes(patch.status)) data.status = patch.status;
    return this.prisma.mindChain.update({ where: { id }, data }).catch(() => null);
  }

  confirm(id: string) {
    return this.prisma.mindChain.update({ where: { id }, data: { validated: 'confirmed', confidence: 0.95, shifted: false, lastSeenDay: this.today() } }).catch(() => null);
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
    const tmpl = await this.prompts.get('lab.chainParse');
    const prompt = `${tmpl}\n\nUSER:\n${t.slice(0, 800)}`;
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

  // --- Grounding guards so the engine can't confabulate the user's history. (BEA-602) ---
  private flatten(s: string): string {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  private lev(a: string, b: string): number {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[b.length];
  }
  // Capitalised words that are NOT person-names — sentence starters, cue words, common terms.
  private static NAME_STOP = new Set(
    "when i today tomorrow yesterday monday tuesday wednesday thursday friday saturday sunday after before the a an and or but his her he she they them their this that these those my me you we us move end start finish focus work working production beakn beacon morning afternoon lunch coffee dinner evening night day days week weeks month task tasks meeting meetings"
      .split(' '),
  );
  /** A proposed chain is GROUNDED only if its evidence quote really sits in the day's words AND it names no one absent from them. */
  private isGrounded(text: string, evidence: string, corpusFlat: string, corpusWords: Set<string>): boolean {
    const ev = this.flatten(evidence);
    if (ev.length < 12 || !corpusFlat.includes(ev)) return false; // the quote must be verbatim from the day's words
    const names = (text.match(/\b[A-Z][a-z]{2,}\b/g) || []).filter((w) => !MindChainService.NAME_STOP.has(w.toLowerCase()));
    for (const nm of names) {
      const low = nm.toLowerCase();
      if (corpusWords.has(low)) continue;
      let near = false;
      for (const w of corpusWords) {
        if (w.length >= 3 && this.lev(low, w) <= 2) {
          near = true;
          break;
        }
      }
      if (!near) return false; // a name the day's own words never mention → confabulation, drop it
    }
    return true;
  }

  /** Propose Goal→Blocker→Lever chains grounded ONLY in the day's own story. Saved as source='engine'. (BEA-516/602) */
  async inferFromDay(day: string): Promise<number> {
    const [tasks, story, existing] = await Promise.all([
      // The day's real record — keyed to `day` this saw only what was created that day. (BEA-1018)
      this.prisma.task.findMany({ where: await this.tasks.whereForDay(day), select: { title: true, status: true, category: true, rolloverCount: true } }),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' }, select: { rawText: true } }),
      this.prisma.mindChain.findMany({ where: { status: { not: 'retired' } }, select: { goal: true, blocker: true } }),
    ]);
    const deferred = tasks.filter((t) => (t.rolloverCount || 0) > 0 && t.status !== 'done');
    const storyText = (story?.rawText || '').trim();
    if (!storyText) return 0; // a Situation must be grounded in the day's OWN story; no story → infer nothing

    const tmpl = await this.prompts.get('lab.chainInfer');
    const prompt =
      `${tmpl}\n\n` +
      (deferred.length ? `REPEATEDLY DEFERRED TASKS:\n${deferred.map((t) => `- ${t.title}${t.category ? ` [${t.category}]` : ''} (deferred ${t.rolloverCount}×)`).join('\n')}\n\n` : '') +
      `TODAY'S STORY:\n${storyText.slice(0, 1500)}`;
    const raw = (await this.llm.completeWith(PARSE_MODEL, prompt, 600, 'chain-infer'))?.trim() || '';
    let list: { goal?: string; blocker?: string; lever?: string; evidence?: string }[] = [];
    try {
      const jjson = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (Array.isArray(jjson?.chains)) list = jjson.chains;
    } catch {
      list = [];
    }

    const corpusFlat = this.flatten(`${storyText} ${deferred.map((t) => t.title).join(' ')}`);
    const corpusWords = new Set(corpusFlat.split(' ').filter(Boolean));
    const deferredNames = deferred.slice(0, 3).map((t) => t.title).join(', ');
    let created = 0;
    for (const c of list.slice(0, 2)) {
      const goal = String(c?.goal || '').trim();
      const blocker = String(c?.blocker || '').trim();
      const lever = String(c?.lever || '').trim();
      const evidence = String(c?.evidence || '').trim();
      if (!goal || !blocker) continue;
      if (!this.isGrounded(`${goal} ${blocker} ${lever}`, evidence, corpusFlat, corpusWords)) continue; // drop confabulations
      if (existing.some((e) => this.isDup({ goal, blocker }, e))) continue;
      const quote = evidence.replace(/\s+/g, ' ').slice(0, 140);
      const provenance = `Noticed on ${day} · from your words: "${quote}"${deferredNames ? ` · deferred: ${deferredNames}` : ''}`;
      await this.create({ goal, blocker, lever, source: 'engine', provenance });
      existing.push({ goal, blocker }); // so two proposals this run don't duplicate each other
      created++;
    }
    return created;
  }

  /**
   * Re-check active chains against a freshly-closed day — Theory of Constraints' "repeat" step (BEA-526).
   * Once a lever moves the blocker shifts, so a set-once Situation goes stale. For each active chain we ask
   * (cheaply) whether today's progress means the blocker HELD, SHIFTED, or is RESOLVED, and update it:
   *   resolved → mark resolved (it drops out of the Mentor/Coach grounding);
   *   shifted  → update the blocker + lever and flag `shifted` so the UI can gently ask "does this still fit?".
   * Conservative: only acts on a clear signal; caps the work at the few most relevant chains.
   */
  async reviewActiveChains(day: string): Promise<{ resolved: number; shifted: number }> {
    const [chains, doneTasks, story] = await Promise.all([
      this.prisma.mindChain.findMany({
        where: { status: 'active', NOT: { validated: 'refuted' } },
        orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
        take: 6,
      }),
      this.prisma.task.findMany({ where: { status: 'done', completedAt: await this.tasks.dayWindow(day).then((w) => ({ gte: w.start, lt: w.end })) }, select: { title: true, category: true } }),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' }, select: { rawText: true } }),
    ]);
    if (!chains.length) return { resolved: 0, shifted: 0 };
    const doneList = doneTasks.map((t) => `- ${t.title}${t.category ? ` [${t.category}]` : ''}`).join('\n');
    const storyText = (story?.rawText || '').slice(0, 1500);
    if (!doneList && !storyText.trim()) return { resolved: 0, shifted: 0 }; // nothing happened today to change anything

    let resolved = 0;
    let shifted = 0;
    for (const c of chains) {
      const tmpl = await this.prompts.get('lab.chainReview');
      const prompt =
        `${tmpl}\n\n` +
        `GOAL: ${c.goal}\nBLOCKED BY: ${c.blocker}\nLEVER: ${c.lever}\n\n` +
        `WHAT THEY FINISHED TODAY:\n${doneList || '(nothing logged)'}\n\n` +
        `TODAY'S STORY:\n${storyText || '(none)'}`;
      const raw = (await this.llm.completeWith(PARSE_MODEL, prompt, 300, 'chain-review'))?.trim() || '';
      let j: { verdict?: string; blocker?: string; lever?: string; why?: string } = {};
      try {
        j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      } catch {
        continue; // unparseable → leave the chain untouched
      }
      const verdict = String(j?.verdict || 'held').toLowerCase();
      if (verdict === 'resolved') {
        await this.prisma.mindChain.update({ where: { id: c.id }, data: { status: 'resolved', lastSeenDay: day } }).catch(() => null);
        await this.prisma.mindRun.create({ data: { kind: 'learn', day, detail: `situation resolved: ${c.goal.slice(0, 80)}` } }).catch(() => undefined);
        resolved++;
      } else if (verdict === 'shifted') {
        const newBlocker = String(j?.blocker || '').trim().slice(0, 200);
        const newLever = String(j?.lever || '').trim().slice(0, 200);
        if (!newBlocker || this.overlap(newBlocker, c.blocker)) continue; // not actually different → skip
        const why = String(j?.why || '').trim().slice(0, 200);
        await this.prisma.mindChain
          .update({
            where: { id: c.id },
            data: {
              blocker: newBlocker,
              lever: newLever || c.lever,
              shifted: true,
              validated: null, // it's an engine guess again → wants a fresh look
              note: why ? `Blocker may have shifted: ${why}` : c.note,
              provenance: `Updated ${day}${why ? ` — ${why}` : ' — your day suggested the blocker moved'}`.slice(0, 300),
              lastSeenDay: day,
            },
          })
          .catch(() => null);
        await this.prisma.mindRun.create({ data: { kind: 'learn', day, detail: `situation shifted: ${c.goal.slice(0, 80)}` } }).catch(() => undefined);
        shifted++;
      }
    }
    return { resolved, shifted };
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
