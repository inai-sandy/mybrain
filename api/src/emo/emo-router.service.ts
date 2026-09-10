import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmoAgentLaneService } from './emo-agent-lane.service';
import { wordCount } from '../voice/whisper-rescue';
import { EmoCardsService, EmoLane } from './emo-cards.service';
import { EmoSearchService } from './emo-search.service';
import { EmoTaskService } from './emo-task.service';
import { EmoIdeaService } from './emo-idea.service';
import { EmoReminderService } from './emo-reminder.service';
import { EmoMeetingService } from './emo-meeting.service';
import { EmoCloseService } from './emo-close.service';
import { EmoBriefService } from './emo-brief.service';
import { EmoResearchService } from './emo-research.service';
import { PromptsService } from '../prompts/prompts.service';

type Segment = { lane: EmoLane; summary: string; text: string };

const LANES: EmoLane[] = ['task', 'reminder', 'story', 'meeting', 'search', 'research', 'note', 'idea', 'close', 'brief', 'agent'];
// Which lanes are terminal (the card itself IS the result) vs need a lane to process them.
const TERMINAL = new Set<EmoLane>(['story', 'note']);

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
    private readonly ideaLane: EmoIdeaService,
    private readonly reminderLane: EmoReminderService,
    private readonly meetingLane: EmoMeetingService,
    private readonly researchLane: EmoResearchService,
    private readonly closeLane: EmoCloseService, // last on purpose: keeps positional wiring stable
    private readonly briefLane: EmoBriefService,
    private readonly prompts: PromptsService,
    private readonly agentLane: EmoAgentLaneService,
  ) {}

  /** How much of a transcript has to survive the router before we call it intact. */
  private static readonly COVERAGE_MIN = 0.85;

  /**
   * The router's `text` is written by an LLM, not sliced out of the transcript — so a lazy or
   * truncated answer used to throw your words away silently. Found 2026-09-08: a 24.7 s recording
   * that Deepgram transcribed as 27 words ("This is demo recording to understand how it performs
   * well…") reached the card as **"This is"**. Three recordings in a row lost the same way, and
   * nothing anywhere noticed.
   *
   * Two rules now make that impossible:
   *   * ONE segment means nothing was split, so the card carries the transcript VERBATIM. The LLM
   *     still supplies the lane and the summary — it just no longer gets to rewrite your words.
   *   * SEVERAL segments keep their own text (the lanes read it: a research card must not inherit
   *     a task's words), but if the pieces together have lost more than 15% of what you said, the
   *     whole transcript is filed as an extra note as well. We cannot know WHICH words the LLM
   *     dropped, so we keep all of them rather than guess.
   */
  private keepEveryWord(segments: Segment[], transcript: string): Segment[] {
    const words = wordCount;                      /* one word-counter for the app (cross-change review) */
    const total = words(transcript);
    if (!total) return segments;

    if (segments.length === 1) {
      const kept = words(segments[0].text);
      if (kept < total) {
        this.log.warn(`router rewrote a single segment down to ${kept}/${total} words — filing your transcript verbatim instead`);
      }
      return [{ ...segments[0], text: transcript }];
    }

    // KNOWN LIMIT, deliberately left: this counts words, it does not check they are HIS words, so
    // a paraphrase of roughly the right length still passes. Matching word-for-word instead was
    // written and thrown away — a real split legitimately rephrases ("remind Dharmendra on Friday"
    // out of "can you remind Dharmendra on Friday please"), so an identity check fired on ordinary
    // recordings and would have buried him in duplicate note cards. Picking a threshold that
    // separates a rephrase from a fabrication needs measurements of the live router we do not have
    // yet. The case that actually bit him — one segment, truncated — is covered exactly, above.
    const covered = segments.reduce((n, s) => n + words(s.text), 0);
    if (covered >= total * EmoRouterService.COVERAGE_MIN) return segments;

    this.log.warn(`router segments cover only ${covered}/${total} words — adding a note card with the full transcript`);
    return [...segments, { lane: 'note' as EmoLane, summary: transcript.replace(/\s+/g, ' ').slice(0, 120), text: transcript }];
  }

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
  async route(transcript: string, opts: { audioPath?: string | null; source?: string; lane?: EmoLane } = {}): Promise<{ cards: any[] }> {
    const text = (transcript || '').trim();
    if (!text) return { cards: [] };

    let segments: Segment[];
    if (opts.lane && LANES.includes(opts.lane)) {
      // Forced mode (Meeting/Research from the app) — exactly one card in that lane, no guessing.
      segments = [{ lane: opts.lane, summary: text.replace(/\s+/g, ' ').slice(0, 120), text }];
    } else {
      // Routing is a tiny classification job — a heavyweight default model made 5s captures take 15s+ (BEA-929).
      const routerTmpl = await this.prompts.get('emo.router');
      // The router's model is the `emo-router` helper (BEA-1624): its row is `emo.router.model` —
      // the one the EMO settings screen writes — and its default lives in LlmService.HELPERS, so
      // this service never carries a model id of its own.
      const raw = await this.llm.completeHelper('emo-router', `${routerTmpl}\n\nTranscript:\n${text}`, 800, 'emo-router').catch(() => null);
      segments = this.parseSegments(raw, text);
      // Nothing is lost: if the router couldn't make sense of it, keep the whole thing as a note.
      if (!segments.length) {
        this.log.warn('router produced no segments — filing a fallback note card');
        segments = [{ lane: 'note', summary: text.replace(/\s+/g, ' ').slice(0, 120), text }];
      }
      segments = this.keepEveryWord(segments, text);
    }

    // A story told before noon belongs to a still-open yesterday (BEA-981); every other lane keeps the real day.
    const storyDay = segments.some((s) => s.lane === 'story') ? await this.cards.storyDay().catch(() => undefined) : undefined;

    const cards: any[] = [];
    for (const s of segments) {
      const card = await this.cards.create({
        lane: s.lane,
        day: s.lane === 'story' ? storyDay : undefined,
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
        else if (card.lane === 'close') void this.closeLane.handle(card.id).catch(() => undefined); // (BEA-1033)
        else if (card.lane === 'brief') void this.briefLane.handle(card.id).catch(() => undefined); // (BEA-1032)
        else if (card.lane === 'idea') void this.ideaLane.handle(card.id).catch(() => undefined);
        else if (card.lane === 'reminder') void this.reminderLane.handle(card.id).catch(() => undefined);
        else if (card.lane === 'meeting') void this.meetingLane.handle(card.id).catch(() => undefined);
        else if (card.lane === 'research') void this.researchLane.handle(card.id).catch(() => undefined);
        else if (card.lane === 'agent') void this.agentLane.handle(card.id).catch(() => undefined); // run a saved agent by voice (BEA-1086)
      }
    }
    return { cards };
  }
}
