import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { TasksService } from '../tasks/tasks.service';
import { EmoCardsService } from './emo-cards.service';
import { PromptsService } from '../prompts/prompts.service';

/**
 * EMO (BEA-868) — the Meetings lane. A "meeting" card → a structured meeting card: a summary (key
 * points + decisions) on top, action items pulled out and auto-created as Tasks, and the full
 * transcript below. NOTE: browser recordings aren't stored (BEA-874), so speaker diarization
 * (Speaker 1/2…) arrives with the dedicated meeting-record mode / the Emo device; here we work from
 * the plain transcript, which still yields the summary + action items (the high-value parts).
 */
/** Cut a labelled transcript into pieces for the per-chunk notes. Prefers a line break in the back
 *  half of the piece, then a sentence end, then a hard cut. When the cut lands INSIDE one speaker's
 *  line (a few minutes of monologue with no newline), the next piece starts with that speaker's
 *  label again, so the chunk model never summarises words with no speaker on them (2026-09-11 review).
 *  Pure; at most 30 pieces. */
export function splitTranscript(transcript: string, chunk = 10000): string[] {
  const chunks: string[] = [];
  let carry = '';                                       /* the label to re-insert at the top of the next piece */
  for (let i = 0; i < transcript.length && chunks.length < 30; ) {
    let end = Math.min(i + chunk, transcript.length);
    let midLine = false;
    if (end < transcript.length) {
      const nl = transcript.lastIndexOf('\n', end);
      if (nl > i + chunk / 2) end = nl;
      else {
        const m = transcript.slice(i, end).search(/[.?!]\s(?![\s\S]*[.?!]\s)/);   /* the LAST sentence end in the piece */
        if (m > chunk / 2) end = i + m + 1;
        midLine = true;
      }
    }
    let piece = transcript.slice(i, end);
    if (carry && !/^\s*Speaker \d+:/.test(piece)) piece = `${carry} (continued): ${piece.replace(/^\s+/, '')}`;
    chunks.push(piece);
    if (midLine) {
      const lastLabel = transcript.slice(0, end).match(/(Speaker \d+):(?![\s\S]*Speaker \d+:)/);
      carry = lastLabel ? lastLabel[1] : '';
    } else carry = '';
    i = transcript[end] === '\n' ? end + 1 : end;          /* the line break itself belongs to neither piece */
  }
  return chunks;
}

@Injectable()
export class EmoMeetingService {
  private readonly log = new Logger('EmoMeeting');
  constructor(
    private readonly llm: LlmService,
    private readonly tasks: TasksService,
    private readonly cards: EmoCardsService,
    private readonly prompts: PromptsService,
  ) {}

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'meeting') return;
    const transcript = (card.rawTranscript || '').trim();
    if (!transcript) {
      await this.cards.update(cardId, { status: 'done', summary: 'Empty meeting' });
      return;
    }
    // real speaker count when the transcript is diarized (Speaker 1/2… lines, BEA-941)
    const speakerLabels = new Set((transcript.match(/^Speaker \d+:/gm) || [])).size || null;
    try {
      let summary: string;
      let actionItems: string[];
      let attendees: number | null;
      if (transcript.length <= 12000) {
        const meetingTmpl = await this.prompts.get('emo.meeting');
        const raw = await this.llm.completeHelper('emo-meeting', 
          `${meetingTmpl}\n\nTranscript:\n${transcript}`,
          1000, 'emo-meeting',
        );
        const j = JSON.parse((raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
        summary = String(j.summary || 'No summary.').trim();
        actionItems = Array.isArray(j.actionItems) ? j.actionItems.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
        attendees = Number.isFinite(j.attendees) ? Number(j.attendees) : null;
      } else {
        // long meeting (941): summarize in ~10k chunks, then merge — the whole meeting
        // makes it into the minutes, not just the first 13 minutes.
        const merged = await this.summarizeLong(transcript);
        summary = merged.summary;
        actionItems = merged.actionItems;
        attendees = merged.attendees;
      }
      if (speakerLabels) attendees = speakerLabels;

      const links: any[] = [];
      for (const item of actionItems) {
        const t = await this.tasks.create({ title: item, category: 'Meeting', note: `Action item from a meeting${attendees ? ` (~${attendees} people)` : ''}.`, auto: true }).catch(() => null);
        if (t) links.push({ kind: 'task', id: t.id, label: item.slice(0, 60) });
      }

      const detail = [
        summary,
        links.length ? `\n**Action items → Tasks (${links.length}):**\n${actionItems.map((a) => `- ${a}`).join('\n')}` : '',
        attendees ? `\n_Attendees${speakerLabels ? '' : ' (approx)'}: ${attendees}_` : '',
        speakerLabels ? '' : `\n_No speaker labels on this one. The switch is in Settings → Voice input → Speaker labels for meetings._`,
        `\n\n---\n### Transcript\n${transcript}`,
      ].filter(Boolean).join('\n');

      await this.cards.update(cardId, {
        summary: links.length ? `Meeting — ${links.length} action item${links.length === 1 ? '' : 's'}` : 'Meeting summary',
        detail,
        links,
        status: 'done',
      });
    } catch (e: any) {
      this.log.warn(`meeting lane failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: 'I couldn’t summarise that meeting — the full transcript is saved below. Retry?', error: String(e?.message || e), detail: `Couldn’t summarise the meeting.\n\n---\n### Transcript\n${transcript}` }).catch(() => undefined);
    }
  }

  /** Long meetings: per-chunk notes, then one merge pass — complete minutes at any length. */
  private async summarizeLong(transcript: string): Promise<{ summary: string; actionItems: string[]; attendees: number | null }> {
    const chunks = splitTranscript(transcript, 10000);
    const notes: { points: string[]; decisions: string[]; actionItems: string[] }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkTmpl = await this.prompts.get('emo.meetingChunk');
      const raw = await this.llm.completeHelper('emo-meeting', 
        `${chunkTmpl.replace(/\{\{part\}\}/g, String(i + 1)).replace(/\{\{total\}\}/g, String(chunks.length))}\n\n${chunks[i]}`,
        700, 'emo-meeting-chunk',
      ).catch(() => '');
      try {
        const j = JSON.parse((raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
        notes.push({
          points: Array.isArray(j.points) ? j.points.map((x: any) => String(x)) : [],
          decisions: Array.isArray(j.decisions) ? j.decisions.map((x: any) => String(x)) : [],
          actionItems: Array.isArray(j.actionItems) ? j.actionItems.map((x: any) => String(x)) : [],
        });
      } catch { /* skip an unparsable chunk — the rest still make the minutes */ }
    }
    const flat = (k: 'points' | 'decisions' | 'actionItems') => notes.flatMap((n) => n[k]).filter(Boolean);
    const mergeTmpl = await this.prompts.get('emo.meetingMerge');
    const mergeRaw = await this.llm.completeHelper('emo-meeting', 
      `${mergeTmpl}\n\nKey points:\n${flat('points').map((p) => `- ${p}`).join('\n')}\n\nDecisions:\n${flat('decisions').map((p) => `- ${p}`).join('\n')}\n\nAction items:\n${flat('actionItems').map((p) => `- ${p}`).join('\n')}`,
      1200, 'emo-meeting-merge',
    ).catch(() => '');
    try {
      const j = JSON.parse((mergeRaw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
      return {
        summary: String(j.summary || '').trim() || `**Key points**\n${flat('points').map((p) => `- ${p}`).join('\n')}`,
        actionItems: Array.isArray(j.actionItems) ? j.actionItems.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 12) : flat('actionItems').slice(0, 12),
        attendees: Number.isFinite(j.attendees) ? Number(j.attendees) : null,
      };
    } catch {
      return {
        summary: `**Key points**\n${flat('points').map((p) => `- ${p}`).join('\n')}\n\n**Decisions**\n${flat('decisions').map((p) => `- ${p}`).join('\n')}`,
        actionItems: flat('actionItems').slice(0, 12),
        attendees: null,
      };
    }
  }
}
