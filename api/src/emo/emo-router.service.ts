import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { EmoCardsService, EmoLane } from './emo-cards.service';
import { EmoSearchService } from './emo-search.service';
import { EmoTaskService } from './emo-task.service';
import { EmoReminderService } from './emo-reminder.service';

type Segment = { lane: EmoLane; summary: string; text: string };

const LANES: EmoLane[] = ['task', 'reminder', 'story', 'meeting', 'search', 'research', 'note'];
// Which lanes are terminal (the card itself IS the result) vs need a lane to process them.
const TERMINAL = new Set<EmoLane>(['story', 'note']);

const PROMPT = `You are Emo's intent router. Split a voice note into one or more INTENTS and classify each.

Lanes:
- task — a to-do ("finish the BOM", "email the vendor"). Split several to-dos into several task intents.
- reminder — nudge a PERSON at a time ("remind Dharmendra on Friday").
- story — a reflection / moment about the day ("met the vendor, felt good"; "stressed about the launch").
- search — "search / find / what do we have on / look into…" (a question to answer).
- research — "research / deep research / quick research on…".
- meeting — a long multi-speaker meeting recording.
- note — anything else worth keeping.

One note can hold SEVERAL intents across lanes — output each separately. For each intent give:
- "lane": one of the above
- "summary": one short line of what Emo will do, e.g. "Task: finish the BOM by Friday" / "Reminder: Dharmendra, Fri" / "Search: CCTV market"
- "text": the exact slice of the transcript for that intent

Reply with ONLY JSON, no prose:
{"segments":[{"lane":"task","summary":"…","text":"…"}]}`;

/**
 * EMO (BEA-863) — the AI intent router. A transcript in → one or more cards out. It classifies +
 * splits + summarises; each lane issue (865–871) then processes its cards. If the LLM is unsure it
 * files ONE note card with the whole transcript, so nothing is ever lost (the core Emo rule).
 */
@Injectable()
export class EmoRouterService {
  private readonly log = new Logger('EmoRouter');
  constructor(
    private readonly llm: LlmService,
    private readonly cards: EmoCardsService,
    private readonly search: EmoSearchService,
    private readonly taskLane: EmoTaskService,
    private readonly reminderLane: EmoReminderService,
  ) {}

  private parseSegments(raw: string | null, transcript: string): Segment[] {
    try {
      const m = (raw || '').match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : null;
      const segs: Segment[] = Array.isArray(j?.segments) ? j.segments : [];
      const clean = segs
        .filter((s) => s && LANES.includes(s.lane as EmoLane) && (s.summary || s.text))
        .map((s) => ({ lane: s.lane as EmoLane, summary: String(s.summary || '').slice(0, 200).trim(), text: String(s.text || transcript).slice(0, 8000) }));
      return clean;
    } catch {
      return [];
    }
  }

  /** Route a transcript into cards. `audioPath`/`source` are threaded onto every card (the receipt). */
  async route(transcript: string, opts: { audioPath?: string | null; source?: string } = {}): Promise<{ cards: any[] }> {
    const text = (transcript || '').trim();
    if (!text) return { cards: [] };

    const raw = await this.llm.complete(`${PROMPT}\n\nTranscript:\n${text}`, 800, 'emo-router').catch(() => null);
    let segments = this.parseSegments(raw, text);

    // Nothing is lost: if the router couldn't make sense of it, keep the whole thing as a note.
    if (!segments.length) {
      this.log.warn('router produced no segments — filing a fallback note card');
      segments = [{ lane: 'note', summary: text.replace(/\s+/g, ' ').slice(0, 120), text }];
    }

    const cards: any[] = [];
    for (const s of segments) {
      const card = await this.cards.create({
        lane: s.lane,
        // story/note are terminal (the card is the result); actionable lanes wait for their handler.
        status: TERMINAL.has(s.lane) ? 'done' : 'cooking',
        summary: s.summary || null,
        rawTranscript: s.text,
        source: opts.source ?? 'emo',
        audioPath: opts.audioPath ?? null,
      }).catch((e) => { this.log.warn(`card create failed (${s.lane}): ${e?.message || e}`); return null; });
      if (card) {
        cards.push(card);
        // Hand each card to its lane. Search always clarifies first (869); Tasks creates real tasks (866).
        if (card.lane === 'search') void this.search.clarify(card.id).catch(() => undefined);
        else if (card.lane === 'task') void this.taskLane.handle(card.id).catch(() => undefined);
        else if (card.lane === 'reminder') void this.reminderLane.handle(card.id).catch(() => undefined);
      }
    }
    return { cards };
  }
}
