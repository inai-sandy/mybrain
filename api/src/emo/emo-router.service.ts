import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmoCardsService, EmoLane } from './emo-cards.service';
import { EmoSearchService } from './emo-search.service';
import { EmoTaskService } from './emo-task.service';
import { EmoReminderService } from './emo-reminder.service';
import { EmoMeetingService } from './emo-meeting.service';
import { EmoResearchService } from './emo-research.service';

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

IMPORTANT — be CONSERVATIVE. Output the FEWEST segments possible:
- A single command is ONE segment. "Remind <person> about <topic>" = exactly ONE reminder, nothing else. "Add a task to <X>" = exactly ONE task.
- NEVER create a "search" or "research" intent unless the user EXPLICITLY says to search / find / look into / research something. A reminder or task that merely MENTIONS a topic is NOT a search — do not add one.
- Only split into multiple segments when there are clearly SEPARATE, distinct actions (e.g. two different to-dos, or a task AND a reminder). When in doubt, keep it as one.

For each intent give:
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
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly cards: EmoCardsService,
    private readonly search: EmoSearchService,
    private readonly taskLane: EmoTaskService,
    private readonly reminderLane: EmoReminderService,
    private readonly meetingLane: EmoMeetingService,
    private readonly researchLane: EmoResearchService,
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
    /** Fast brain for routing — Haiku by default; overridable via `emo.router.model`. */
  private async routerModel() {
    const row = await this.prisma.setting.findUnique({ where: { key: 'emo.router.model' } }).catch(() => null);
    if (row) { try { const v = JSON.parse(row.value); if (v?.provider && v?.model) return v; } catch { /* default */ } }
    return { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' };
  }

  async route(transcript: string, opts: { audioPath?: string | null; source?: string; lane?: EmoLane } = {}): Promise<{ cards: any[] }> {
    const text = (transcript || '').trim();
    if (!text) return { cards: [] };

    let segments: Segment[];
    if (opts.lane && LANES.includes(opts.lane)) {
      // Forced mode (Meeting/Research from the app) — exactly one card in that lane, no guessing.
      segments = [{ lane: opts.lane, summary: text.replace(/\s+/g, ' ').slice(0, 120), text }];
    } else {
      // Routing is a tiny classification job — a heavyweight default model made 5s captures take 15s+ (BEA-929).
      const raw = await this.llm.completeWith(await this.routerModel(), `${PROMPT}\n\nTranscript:\n${text}`, 800, 'emo-router').catch(() => null);
      segments = this.parseSegments(raw, text);
      // Nothing is lost: if the router couldn't make sense of it, keep the whole thing as a note.
      if (!segments.length) {
        this.log.warn('router produced no segments — filing a fallback note card');
        segments = [{ lane: 'note', summary: text.replace(/\s+/g, ' ').slice(0, 120), text }];
      }
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
        // Hand each card to its lane. Search clarifies first (869) — except from the EMO
        // device, which never asks questions (938): there the search runs immediately.
        if (card.lane === 'search') {
          if (opts.source === 'emo-device') void this.search.run(card.id).catch(() => undefined);
          else void this.search.clarify(card.id).catch(() => undefined);
        }
        else if (card.lane === 'task') void this.taskLane.handle(card.id).catch(() => undefined);
        else if (card.lane === 'reminder') void this.reminderLane.handle(card.id).catch(() => undefined);
        else if (card.lane === 'meeting') void this.meetingLane.handle(card.id).catch(() => undefined);
        else if (card.lane === 'research') void this.researchLane.handle(card.id).catch(() => undefined);
      }
    }
    return { cards };
  }
}
