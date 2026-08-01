import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { NEWS_CATEGORIES, NewsCategory, UNCATEGORISED } from './news-categorise.service';

/**
 * Codex writes the edition (BEA-1257).
 *
 * **It writes WORDS, never the page.** The owner asked directly, and the answer matters: if the
 * engine produced HTML we would get a differently-shaped site every morning, layouts that break at
 * random, no way to prove the story count survived, and an injection hole on a page meant to be
 * shared publicly. So this returns plain fields — a headline, five lines, one line per category and
 * a paragraph per category — and the template built once in BEA-1261 renders them the same way
 * every day.
 *
 * This runs on the FLAT-RATE engine, so the writing is the free part. We never hand it raw XML
 * and never ask it to fetch or save: it gets the already split, already categorised stories and is
 * asked to write. Note that is OUR discipline about what we send, not a sandbox — a plain
 * `completeHelper` call has no per-run tool gating, and the mybrain MCP server is mounted on every
 * Codex run (see CLAUDE.md). Same for every other FOLLOW_ENGINE helper.
 */

export type WrittenSection = {
  category: NewsCategory;
  /** The one-line summary for the contents strip. */
  line: string;
  /** The written paragraphs. Empty when the engine could not write this one. */
  prose: string;
  storyCount: number;
  /** False when the engine failed on this section — the stories still publish, listed plainly. */
  written: boolean;
};

export type EditionDraft = {
  headline: string;
  sixty: string[];
  sections: WrittenSection[];
  storyCount: number;
  /** True only when every section was written. False publishes an honest, visibly plainer edition. */
  engineOk: boolean;
  /** What went wrong, in plain words, when something did. */
  notes: string[];
};

/** Stories that reach the engine are trimmed — it is summarising, not republishing. */
const STORY_CHARS = 1200;
/** A section's write-up. Generous: this is the flat-rate step. */
const SECTION_TOKENS = 1400;
const TOPLINE_TOKENS = 900;

@Injectable()
export class NewsWriteService {
  private readonly log = new Logger('NewsWrite');
  /** Editions being written right now — a second publish would race the issue number. */
  private readonly inFlight = new Set<string>();

  constructor(
    readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  /**
   * Write one issue's edition.
   *
   * Never throws for an engine failure. A day where Codex is down should still produce a real
   * edition — every story, every link, every category, just without the prose — and it must SAY so
   * rather than quietly looking thin. A run may never claim success when a step failed.
   */
  async writeEdition(issueId: string): Promise<EditionDraft> {
    const stories = await this.prisma.newsStory.findMany({
      where: { issueId, kind: 'story' },
      orderBy: { order: 'asc' },
      select: { id: true, text: true, theme: true, category: true },
    });
    if (!stories.length) throw new Error(`issue ${issueId} has no stories to write about — split and categorise it first`);

    const uncategorised = stories.filter((s) => !s.category).length;
    if (uncategorised) {
      throw new Error(`${uncategorised} of ${stories.length} stories have no category yet — categorise the issue before writing`);
    }

    const notes: string[] = [];
    const sections: WrittenSection[] = [];

    // Fixed order, always. Familiarity is most of why someone comes back to a daily paper.
    for (const category of NEWS_CATEGORIES) {
      const mine = stories.filter((s) => s.category === category);
      if (!mine.length) continue; // an empty category renders as nothing, not an empty heading

      const written = await this.writeSection(category, mine).catch((e: any) => {
        this.log.error(`section "${category}" failed: ${e?.message || e}`);
        notes.push(`The write-up for "${category}" could not be produced (${e?.message || e}). Its ${mine.length} stories are listed in full below.`);
        return null;
      });

      sections.push({
        category,
        line: written?.line || `${mine.length} ${mine.length === 1 ? 'story' : 'stories'}`,
        prose: written?.prose || '',
        storyCount: mine.length,
        written: Boolean(written),
      });
    }

    const topline = await this.writeTopline(sections, stories).catch((e: any) => {
      this.log.error(`headline and sixty-second read failed: ${e?.message || e}`);
      notes.push(`The headline and the 60-second read could not be produced (${e?.message || e}).`);
      return null;
    });

    const engineOk = sections.every((s) => s.written) && Boolean(topline);
    return {
      headline: topline?.headline || this.fallbackHeadline(sections, stories.length),
      sixty: topline?.sixty || [],
      sections,
      storyCount: stories.length,
      engineOk,
      notes,
    };
  }

  /**
   * Write the edition and store it, so a day is written once and rendered many times.
   *
   * Re-running replaces the day's edition rather than making a second one — the issue number and
   * the day are kept, because the masthead says "Issue No. 4" and that must not change under a
   * reader who already has the link.
   */
  async publishEdition(issueId: string): Promise<{ id: string; number: number; day: string; engineOk: boolean; storyCount: number; notes: string[] }> {
    if (this.inFlight.has(issueId)) {
      throw new Error('this edition is already being written — wait for that to finish rather than racing it');
    }
    this.inFlight.add(issueId);
    try {
      return await this.runPublish(issueId);
    } finally {
      this.inFlight.delete(issueId);
    }
  }

  private async runPublish(issueId: string) {
    const issue = await this.prisma.newsIssue.findUnique({ where: { id: issueId } });
    if (!issue) throw new Error(`no such issue: ${issueId}`);

    const draft = await this.writeEdition(issueId);

    // The day the issue covers, in the owner's timezone, and also its public address.
    const day = new Date(new Date(issue.pubDate).getTime() + 330 * 60000).toISOString().slice(0, 10);

    const body = {
      headline: draft.headline,
      sixty: JSON.stringify(draft.sixty),
      sections: JSON.stringify(draft.sections),
      storyCount: draft.storyCount,
      engineOk: draft.engineOk,
      notes: JSON.stringify(draft.notes),
      // Writing IS publishing — this is the step that makes an edition readable. Leaving it false
      // would give a perfect run an edition nobody can open.
      published: true,
    };

    const existing = await this.prisma.newsEdition.findUnique({ where: { issueId } });
    if (existing) {
      const row = await this.prisma.newsEdition.update({ where: { id: existing.id }, data: body });
      return { id: row.id, number: row.number, day: row.day, engineOk: row.engineOk, storyCount: row.storyCount, notes: draft.notes };
    }

    // A day holds exactly one edition. Two issues landing on the same IST day — a double post, or a
    // pubDate that straddles the offset — would otherwise collide on the unique day and 500 on every
    // retry, with no way to tell what went wrong.
    const sameDay = await this.prisma.newsEdition.findUnique({ where: { day } });
    if (sameDay) {
      throw new Error(
        `${day} already has an edition (issue ${sameDay.issueId}, No. ${sameDay.number}). Two issues landed on the same day — pick one, or delete that edition first.`,
      );
    }

    // Issue numbers are sequential and permanent. Counting rows would reuse a number if one were
    // ever deleted, so take the highest ever issued and add one. Two publishes at once could still
    // read the same top, so a collision retries once rather than surfacing a raw constraint error.
    for (let attempt = 0; attempt < 2; attempt++) {
      const top = await this.prisma.newsEdition.findFirst({ orderBy: { number: 'desc' }, select: { number: true } });
      try {
        const row = await this.prisma.newsEdition.create({
          data: { issueId, number: (top?.number || 0) + 1 + attempt, day, ...body },
        });
        return { id: row.id, number: row.number, day: row.day, engineOk: row.engineOk, storyCount: row.storyCount, notes: draft.notes };
      } catch (e: any) {
        const clash = String(e?.code) === 'P2002' || /unique/i.test(e?.message || '');
        if (!clash || attempt === 1) throw e;
        this.log.warn(`issue number collided while publishing ${issueId}; taking the next one`);
      }
    }
    throw new Error('could not assign an issue number');
  }

  /** One category, one engine call. Returns a contents line and the prose. */
  private async writeSection(category: NewsCategory, stories: { text: string; theme: string | null }[]) {
    const template = await this.prompts.get('news.section');
    const body = stories
      .map((s, i) => `${i + 1}. ${s.theme ? `[${s.theme}] ` : ''}${s.text.replace(/\s+/g, ' ').slice(0, STORY_CHARS)}`)
      .join('\n\n');

    const out = await this.llm.completeHelper(
      'news-write',
      `${template}\n\nThe category: ${category}\nThe stories (${stories.length}):\n\n${body}`,
      SECTION_TOKENS,
      'news-write',
    );
    if (!out || !out.trim()) throw new Error('the engine returned nothing');

    const parsed = this.parseSection(out);
    if (!parsed.prose) throw new Error('the engine returned no write-up');
    return parsed;
  }

  /** The headline and the five lines most readers will read instead of the rest. */
  private async writeTopline(sections: WrittenSection[], stories: { text: string; category: string | null }[]) {
    const template = await this.prompts.get('news.topline');
    const digest = sections
      .map((s) => `## ${s.category} (${s.storyCount})\n${s.prose ? s.prose.slice(0, 1500) : stories.filter((x) => x.category === s.category).slice(0, 6).map((x) => `- ${x.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')}`)
      .join('\n\n');

    const out = await this.llm.completeHelper('news-write', `${template}\n\nToday's sections:\n\n${digest}`, TOPLINE_TOKENS, 'news-write');
    if (!out || !out.trim()) throw new Error('the engine returned nothing');

    const headline = this.firstTagged(out, 'HEADLINE');
    // Only read lines AFTER the headline. The digest we send embeds each section's prose verbatim,
    // so a model that echoes a stray dash from it would otherwise have that scooped into the
    // 60-second read, quietly pushing a real item out of a list capped at five.
    const headlineAt = /^\s*HEADLINE\s*:/im.exec(out);
    const body = headlineAt ? out.slice(headlineAt.index + headlineAt[0].length) : out;
    const sixty = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(?:[-*•]|\d+[.)])\s+/.test(l))
      .map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim())
      .filter(Boolean)
      .slice(0, 5);

    if (!headline && !sixty.length) throw new Error('the engine\'s reply had neither a headline nor any lines');
    return { headline: headline || '', sixty };
  }

  /** Pull `LINE: …` and everything after `WRITE-UP:` out of a section reply. */
  private parseSection(out: string): { line: string; prose: string } {
    const line = this.firstTagged(out, 'LINE');
    const m = /WRITE-?UP\s*:\s*/i.exec(out);
    let prose = m ? out.slice(m.index + m[0].length) : out;
    // If the engine ignored the labels entirely, the whole reply is still the write-up — better a
    // slightly untidy section than an empty one.
    if (line) prose = prose.replace(new RegExp(`^\\s*${escapeRe(line)}\\s*`), '');
    return { line: line || '', prose: prose.trim() };
  }

  private firstTagged(out: string, tag: string): string {
    const m = new RegExp(`^\\s*${tag}\\s*:\\s*(.+)$`, 'im').exec(out);
    return m ? m[1].trim().replace(/^["'“]|["'”]$/g, '') : '';
  }

  /**
   * A headline written from the facts when the engine could not write one. Smol AI titles most days
   * "not much happened today", so falling back to their title would be worse than useless.
   */
  private fallbackHeadline(sections: WrittenSection[], total: number): string {
    const biggest = [...sections].filter((s) => s.category !== UNCATEGORISED).sort((a, b) => b.storyCount - a.storyCount)[0];
    if (!biggest) return `${total} ${total === 1 ? 'story' : 'stories'} in AI today`;
    return `${total} ${total === 1 ? 'story' : 'stories'} in AI today, mostly ${biggest.category.toLowerCase()}`;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
