import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';

/**
 * Files every story of an issue into one of the owner's fixed categories (BEA-1256).
 *
 * The categories are FIXED and were approved on 2026-08-01. The model does not invent new ones: a
 * name it returns that is not on the list is thrown away and the story lands in `Uncategorised`,
 * which is a real, visible category rather than a bin. The owner's rule is that nothing hides.
 *
 * This is the only paid step in the whole news pipeline — a batched call to a small model, a
 * sentence in and a category name out.
 */
export const NEWS_CATEGORIES = [
  'Models & releases',
  'Research',
  'Tools & building',
  'Money & business',
  'Policy & law',
  'Chips & hardware',
  'Talk & opinion',
  'Uncategorised',
] as const;

export type NewsCategory = (typeof NEWS_CATEGORIES)[number];
export const UNCATEGORISED: NewsCategory = 'Uncategorised';

export type CategoriseOutcome = {
  ok: boolean;
  issueId: string;
  /** Stories that needed a category. */
  total: number;
  /** How many the model placed on the list. */
  placed: number;
  /** How many fell through to Uncategorised — never dropped. */
  uncategorised: number;
  batches: number;
  message?: string;
};

/** How many stories go into one model call. Small enough to stay well inside a reply. */
const BATCH = 25;
/** Room for one line of JSON per story, with slack. */
const TOKENS_PER_STORY = 40;
/** Each story is trimmed before it is sent — the model is filing, not reading the whole thing. */
const SNIPPET = 400;

@Injectable()
export class NewsCategoriseService {
  private readonly log = new Logger('NewsCategorise');

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  /** Normalise whatever the model said into a real category, or null if it is not one of ours. */
  static toCategory(raw: unknown): NewsCategory | null {
    if (typeof raw !== 'string') return null;
    const want = raw.trim().toLowerCase();
    return (NEWS_CATEGORIES as readonly string[]).find((c) => c.toLowerCase() === want) as NewsCategory | undefined ?? null;
  }

  /**
   * Categorise one issue's stories.
   *
   * Carries the count guarantee forward from BEA-1255: every story that went in comes out with a
   * category. A batch the model fluffs — truncated, malformed, missing lines — leaves its stories
   * as `Uncategorised` and the run continues. The count can never shrink.
   */
  async categoriseIssue(issueId: string): Promise<CategoriseOutcome> {
    const stories = await this.prisma.newsStory.findMany({
      where: { issueId, kind: 'story' },
      orderBy: { order: 'asc' },
      select: { id: true, text: true, theme: true, sectionPath: true },
    });

    if (!stories.length) {
      return { ok: false, issueId, total: 0, placed: 0, uncategorised: 0, batches: 0, message: 'this issue has no stories to categorise — split it first' };
    }

    const template = await this.prompts.get('news.categorise');
    const decided = new Map<string, NewsCategory>();
    let batches = 0;

    for (let i = 0; i < stories.length; i += BATCH) {
      const batch = stories.slice(i, i + BATCH);
      batches++;
      try {
        const answer = await this.askForBatch(template, batch);
        for (const [id, category] of answer) decided.set(id, category);
      } catch (e: any) {
        // A failed batch is not a failed run. Its stories fall through to Uncategorised below,
        // where the owner can see them, rather than vanishing or blocking the edition.
        this.log.error(`batch ${batches} of issue ${issueId} failed: ${e?.message || e}`);
      }
    }

    // Write EVERY story, placed or not. This is the line that keeps the count honest.
    let placed = 0;
    let uncategorised = 0;
    for (const s of stories) {
      const category = decided.get(s.id) || UNCATEGORISED;
      if (decided.has(s.id)) placed++;
      else uncategorised++;
      await this.prisma.newsStory.update({ where: { id: s.id }, data: { category } });
    }

    const written = await this.prisma.newsStory.count({ where: { issueId, kind: 'story', category: { not: null } } });
    if (written !== stories.length) {
      throw new Error(
        `count mismatch categorising issue ${issueId}: ${stories.length} stories went in but ${written} came out with a category — refusing to continue`,
      );
    }

    if (uncategorised) {
      this.log.warn(`issue ${issueId}: ${uncategorised}/${stories.length} story(ies) ended up Uncategorised — visible on the page, not dropped`);
    }

    return {
      ok: true,
      issueId,
      total: stories.length,
      placed,
      uncategorised,
      batches,
      message: uncategorised ? `${uncategorised} story(ies) could not be placed and are showing as Uncategorised` : undefined,
    };
  }

  /** Ask the model about one batch. Returns only the answers it got right. */
  private async askForBatch(
    template: string,
    batch: { id: string; text: string; theme: string | null; sectionPath: string }[],
  ): Promise<Map<string, NewsCategory>> {
    const numbered = batch
      .map((s, i) => {
        const context = [s.theme, s.sectionPath].filter(Boolean).join(' — ');
        const body = s.text.replace(/\s+/g, ' ').slice(0, SNIPPET);
        return `${i + 1}. ${context ? `[${context}] ` : ''}${body}`;
      })
      .join('\n\n');

    const out = await this.llm.completeHelper(
      'news-categorise',
      `${template}\n\nThe stories:\n\n${numbered}`,
      batch.length * TOKENS_PER_STORY + 200,
      'news-categorise',
    );
    if (!out) throw new Error('the model returned nothing');

    const parsed = this.parseAnswer(out);
    const map = new Map<string, NewsCategory>();
    for (const { n, category } of parsed) {
      const story = batch[n - 1];
      if (!story) continue; // a number outside the batch is the model's mistake, not a story
      map.set(story.id, category);
    }
    return map;
  }

  /** Pull {"items":[{n,category}]} out of a reply, tolerating code fences and stray prose. */
  private parseAnswer(out: string): { n: number; category: NewsCategory }[] {
    const cleaned = out.replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('the reply was not in the expected format');

    let data: any;
    try {
      data = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new Error('the reply was not valid JSON — it may have been cut off');
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    const out2: { n: number; category: NewsCategory }[] = [];
    for (const it of items) {
      const n = Number(it?.n);
      const category = NewsCategoriseService.toCategory(it?.category);
      // An invented category name is dropped here, so the story falls through to Uncategorised
      // rather than creating a section nobody chose.
      if (!Number.isInteger(n) || n < 1 || !category) continue;
      out2.push({ n, category });
    }
    return out2;
  }

  /** How an issue's stories are spread across the categories — order fixed, empties omitted. */
  async breakdown(issueId: string) {
    const rows = await this.prisma.newsStory.groupBy({
      by: ['category'],
      where: { issueId, kind: 'story' },
      _count: { _all: true },
    });
    const counts = new Map(rows.map((r: any) => [r.category || UNCATEGORISED, r._count._all]));
    return NEWS_CATEGORIES.map((c) => ({ category: c, count: counts.get(c) || 0 })).filter((r) => r.count > 0);
  }
}
