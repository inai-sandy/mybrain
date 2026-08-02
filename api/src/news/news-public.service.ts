import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NewsReadService } from './news-read.service';

/**
 * The public edition (BEA-1261).
 *
 * Anyone with the link reads this — no login. So it is a deliberately SEPARATE shape from the
 * private one, not the same object with a flag on it. Nothing personal can leak through a field
 * somebody forgets to strip, because the private fields are never put in here at all.
 *
 * What is left out on purpose: story ids (they are the handle for the owner's research endpoints),
 * the `flagged` shortlist (that is his reading list, not news), anything about runs or engines, and
 * — owner's decision, 2026-08-02 — the upstream source's name and link. The field is not merely
 * hidden by the page; it is never assembled, so it cannot be rendered back by a later edit.
 */

export type PublicStory = {
  headline: string;
  source: string;
  links: string[];
};

@Injectable()
export class NewsPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly read: NewsReadService,
  ) {}

  /** A story's own headline — the first sentence, trimmed to something scannable. */
  static headlineOf(text: string): string {
    const first = (text || '').split('\n')[0].trim();
    const stop = first.search(/[.!?](\s|$)/);
    const cut = stop > 30 ? first.slice(0, stop + 1) : first;
    return cut.length > 200 ? `${cut.slice(0, 200).trimEnd()}…` : cut;
  }

  /** Editions anyone may read, newest first. */
  async index(limit = 60) {
    const rows = await this.read.list(limit);
    return rows.map((e) => ({ number: e.number, day: e.day, headline: e.headline, storyCount: e.storyCount }));
  }

  /** One edition, stripped to what a stranger should see. */
  async byDay(day: string) {
    const e: any = await this.read.byDay(day);
    if (!e) throw new NotFoundException('No edition for that day');

    return {
      number: e.number,
      day: e.day,
      headline: e.headline,
      sixty: e.sixty,
      storyCount: e.storyCount,
      // A partly-written edition still publishes, and still says so — a reader deserves to know
      // the same thing the owner does.
      complete: e.engineOk && e.complete,
      sections: e.sections.map((s: any) => ({
        category: s.category,
        line: s.line,
        prose: s.prose,
        storyCount: s.storyCount,
        stories: s.stories.map((st: any) => ({
          headline: NewsPublicService.headlineOf(st.text),
          source: st.sourceKind,
          links: st.links,
        })),
      })),
    };
  }

  /** Title + description for the share card a crawler reads. */
  async ogMeta(day: string, origin: string) {
    const e = await this.prisma.newsEdition.findFirst({ where: { day, published: true } });
    if (!e) return null;
    let sixty: string[] = [];
    try {
      sixty = JSON.parse(e.sixty || '[]');
    } catch {
      sixty = [];
    }
    const when = new Date(`${e.day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    return {
      title: `${e.headline} — AI News Daily`,
      description: sixty.slice(0, 3).join(' ') || `${when}: ${e.storyCount} stories in AI, in one read.`,
      url: `${origin}/paper/${e.day}`,
      image: `${origin}/og-default.png`,
    };
  }
}
