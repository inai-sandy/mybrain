import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LearnedShape, Lesson, LessonInput, lessonsFrom } from './tool-lesson';

/**
 * How old a lesson may get without being seen again before its confidence drops. A tool used weekly
 * confirms itself; one nobody has touched for a month may be describing a vendor that has moved on.
 */
export const LESSON_STALE_DAYS = 30;

export type LearnedFact = {
  key: string;
  kind: string;
  text: string;
  param?: string | null;
  timesSeen: number;
  confidence: 'confirmed' | 'seen once' | 'ageing';
  lastConfirmedAt: string;
  callId?: string | null;
  sampleId?: string | null;
  /** Only on a `shape` fact: where the things are and what one carries. Paths and types, no values. */
  shape?: LearnedShape | null;
};

/**
 * The store for what a tool taught us (BEA-1409).
 *
 * Written from the one call site every outside-service call already goes through, so a tool nobody
 * has ever used starts teaching the moment it is first used — with no note from anybody.
 *
 * Never throws. A call that really happened must not be reported as failed because our own notebook
 * could not be written.
 */
@Injectable()
export class ToolLessonService {
  private readonly log = new Logger('ToolLesson');

  constructor(private readonly prisma: PrismaService) {}

  /** Learn from one successful call. Cheap, mechanical, and no model is involved. */
  async learn(input: LessonInput & { callId?: string | null; sampleId?: string | null }): Promise<Lesson[]> {
    try {
      const found = lessonsFrom(input);
      if (!found.length) return [];
      const upsert = this.prisma?.toolLesson?.upsert;
      if (!upsert) return found;
      const now = new Date();
      for (const l of found) {
        await this.prisma.toolLesson
          .upsert({
            where: { actionId_key: { actionId: String(input.actionId), key: l.key } },
            create: {
              actionId: String(input.actionId),
              service: String(input.service || '').toLowerCase(),
              key: l.key,
              kind: l.kind,
              text: l.text,
              param: l.param || null,
              shape: l.shape ? JSON.stringify(l.shape) : null,
              callId: input.callId || null,
              sampleId: input.sampleId || null,
            },
            update: {
              // The words are refreshed too: a vendor that raised its page cap should not be
              // described by a sentence written before it changed.
              text: l.text,
              // A shape is refreshed on every call: a vendor that added a field should be described
              // by what it sends today, not by what it sent the first time anybody looked.
              ...(l.shape ? { shape: JSON.stringify(l.shape) } : {}),
              lastConfirmedAt: now,
              timesSeen: { increment: 1 },
              ...(input.callId ? { callId: input.callId } : {}),
              ...(input.sampleId ? { sampleId: input.sampleId } : {}),
            },
          })
          .catch((e: any) => this.log.warn(`could not write the lesson ${l.key} for ${input.actionId}: ${e?.message || e}`));
      }
      return found;
    } catch (e: any) {
      this.log.warn(`learning from ${input.actionId} failed: ${e?.message || e}`);
      return [];
    }
  }

  /** What this action has taught us, newest confirmation first. */
  async forAction(actionId: string, now = Date.now()): Promise<LearnedFact[]> {
    const rows = (await this.prisma?.toolLesson?.findMany?.({ where: { actionId: String(actionId) }, orderBy: { lastConfirmedAt: 'desc' } }).catch(() => [])) || [];
    return rows.map((r: any) => this.shape(r, now));
  }

  /** The same, for a whole shortlist at once — what the builder and the build brief ask for. */
  async forActions(actionIds: string[], now = Date.now()): Promise<Record<string, LearnedFact[]>> {
    const ids = Array.from(new Set((actionIds || []).map((s) => String(s)).filter(Boolean)));
    if (!ids.length) return {};
    const rows = (await this.prisma?.toolLesson?.findMany?.({ where: { actionId: { in: ids } }, orderBy: { lastConfirmedAt: 'desc' } }).catch(() => [])) || [];
    const out: Record<string, LearnedFact[]> = {};
    for (const r of rows as any[]) {
      const id = String(r.actionId);
      (out[id] = out[id] || []).push(this.shape(r, now));
    }
    return out;
  }

  private shape(r: any, now: number): LearnedFact {
    const seen = new Date(r.lastConfirmedAt || r.createdAt || Date.now()).getTime();
    const days = (now - seen) / 86_400_000;
    // Confidence is a fact about the evidence, not an opinion: how many times, and how long ago.
    const confidence: LearnedFact['confidence'] = days > LESSON_STALE_DAYS ? 'ageing' : Number(r.timesSeen) > 1 ? 'confirmed' : 'seen once';
    return {
      key: String(r.key),
      kind: String(r.kind),
      text: String(r.text),
      param: r.param || null,
      timesSeen: Number(r.timesSeen) || 1,
      confidence,
      lastConfirmedAt: new Date(seen).toISOString(),
      callId: r.callId || null,
      sampleId: r.sampleId || null,
      ...(r.shape ? { shape: safeShape(r.shape) } : {}),
    };
  }

  /** Everything an action taught us, dropped — for a deleted connection or a hand reset. */
  async forget(actionId: string): Promise<void> {
    await this.prisma?.toolLesson?.deleteMany?.({ where: { actionId: String(actionId) } }).catch(() => undefined);
  }
}

function safeShape(raw: any): LearnedShape | null {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && Array.isArray(v.fields) ? v : null;
  } catch {
    return null;
  }
}

/** The learned half of a fact card, in the words the owner and Codex both read. */
export function learnedText(facts: LearnedFact[]): string {
  if (!facts?.length) return '';
  const line = (f: LearnedFact) => `- ${f.text} _(learned by using it — ${f.confidence}${f.timesSeen > 1 ? `, seen ${f.timesSeen} times` : ''})_`;
  return `What using it has taught us:\n${facts.map(line).join('\n')}`;
}

/**
 * The learned shape of one action's answer, for the build brief (BEA-1415).
 *
 * This is what a reading recipe is written FROM when there is no saved answer — which is the case
 * for every service whose answers we deliberately never keep, and those are the services whose
 * shapes the app's general reader is worst at.
 */
export function shapeInWords(actionId: string, shape: LearnedShape): string {
  const lines = [`### ${actionId}`, ''];
  lines.push(shape.listPath ? `The things are at \`${shape.listPath}\` — ${shape.items} of them in the answer we looked at.` : `The answer IS one record (${shape.items}).`);
  lines.push('', 'Each one carries:', '');
  for (const f of shape.fields.slice(0, 60)) lines.push(`- \`${f.path}\` (${f.kind})`);
  lines.push('', 'These paths were seen in a REAL answer. Nothing else is known to exist — a path not on this list will be refused.');
  return lines.join('\n');
}
