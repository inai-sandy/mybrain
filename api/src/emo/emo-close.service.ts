import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmoCardsService } from './emo-cards.service';
import { TasksService } from '../tasks/tasks.service';
import { ContactsService } from '../contacts/contacts.service';
import { matchContactsAll } from '../contacts/person-identity';

/** Words that describe the act, not the work — dropped before matching a title. */
const NOISE = /\b(finished|completed|done|closed|sent|submitted|paid|delivered|handed over|mark|marked|tick|ticked|off|the|a|an|is|are|was|were|has|have|it|that|this|his|her|their|to|for|of|and|now|already|just|please|can|you)\b/gi;

/** Word overlap between what was said and a task title, 0–1. Simple on purpose: it is a filter, not a judge. */
export function titleScore(said: string, title: string): number {
  const words = (s: string) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .replace(NOISE, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const a = words(said);
  const b = words(title);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of b) if (a.has(w)) hit++;
  return hit / b.size;
}

/**
 * "Ramesh finished the GST filing" — closes THAT task. (BEA-1033)
 *
 * EMO had no closing intent at all, so this was classified as a new task: you got a duplicate and
 * the real one stayed open and kept being chased. The rule here is the same as everywhere else in
 * the delegation loop — never guess. One clear match closes; several matches ask; none offers to
 * create instead of silently making a second copy.
 *
 * The owner's own voice is a real CONFIRMATION, not a claim. He is the approver; he does not need
 * to approve himself.
 */
@Injectable()
export class EmoCloseService {
  private readonly log = new Logger('EmoClose');

  constructor(
    private readonly prisma: PrismaService,
    private readonly cards: EmoCardsService,
    private readonly tasks: TasksService,
    private readonly contacts: ContactsService,
  ) {}

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId);
    if (!card) return;
    const said = [card.rawTranscript || card.summary, card.needsAnswer].filter(Boolean).join('. ');
    if (!said.trim()) {
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: "I couldn't hear which job you meant. Say it again?" });
      return;
    }

    // If they answered a "which one?" question with an exact title, that wins.
    const candidates = await this.candidates(said);
    if (!candidates.length) {
      await this.cards.update(cardId, {
        status: 'needs_you',
        needsQuestion: "I couldn't find an open job matching that. Should I add it as a new task instead?",
        needsOptions: ['Add it as a new task'],
        summary: 'Nothing matching to close',
      });
      return;
    }

    // The answer to a "which one?" round: pick by exact title.
    if (card.needsAnswer) {
      const picked = candidates.find((c) => c.title.toLowerCase() === String(card.needsAnswer).trim().toLowerCase());
      if (picked) return this.close(cardId, picked);
      if (/add it as a new task/i.test(card.needsAnswer)) {
        const t = await this.tasks.create({ title: said.slice(0, 160), auto: true });
        await this.cards.update(cardId, {
          status: 'done',
          summary: `Task added: ${t?.title || said.slice(0, 60)}`,
          links: t ? [{ kind: 'task', id: t.id, label: String(t.title).slice(0, 60) }] : [],
        });
        return;
      }
    }

    const best = candidates[0];
    const runnerUp = candidates[1];
    // A clear winner closes. Anything close behind it is ambiguous — ask rather than pick. (BEA-1033)
    if (best.score >= 0.5 && (!runnerUp || best.score - runnerUp.score >= 0.2)) return this.close(cardId, best);

    await this.cards.update(cardId, {
      status: 'needs_you',
      needsQuestion: 'Which one do you mean?',
      needsOptions: candidates.slice(0, 4).map((c) => c.title),
      summary: 'Which job is finished?',
    });
  }

  /** Open tasks that plausibly match, best first. Narrowed to one person when a name was said. */
  private async candidates(said: string): Promise<{ id: string; title: string; score: number; who: string | null }[]> {
    const all = await this.contacts.allForPicker().then((r) => r.contacts).catch(() => [] as any[]);
    // A name in the sentence scopes the search to that person's work.
    let ownerId: string | null = null;
    for (const word of said.split(/[\s,.]+/)) {
      if (word.length < 3) continue;
      const hits = matchContactsAll(all as any[], word);
      if (hits.length === 1) { ownerId = hits[0].id; break; }
    }
    const rows = await this.prisma.task.findMany({
      where: { status: 'open', ...(ownerId ? { ownerContactId: ownerId } : {}) },
      select: { id: true, title: true, ownerContact: { select: { name: true } } },
      take: 500,
    });
    return rows
      .map((t) => ({ id: t.id, title: t.title, who: t.ownerContact?.name || null, score: titleScore(said, t.title) }))
      .filter((t) => t.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  private async close(cardId: string, task: { id: string; title: string; who: string | null }) {
    await this.tasks.setDone(task.id, true);
    this.log.log(`closed by voice: "${task.title}"${task.who ? ` (${task.who})` : ''}`);
    await this.cards.update(cardId, {
      status: 'done',
      summary: `Marked done: ${task.title}`.slice(0, 200),
      detail: task.who ? `Confirmed finished — ${task.who}'s chase has stopped.` : 'Marked done.',
      links: [{ kind: 'task', id: task.id, label: task.title.slice(0, 60) }],
    });
  }
}
