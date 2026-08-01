import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { AgentAreasService } from '../agent/agent-areas.service';
import { AgentService } from '../agent/agent.service';

/**
 * "Worth digging into" (BEA-1258).
 *
 * The owner: "we have to identify any news articles which require research… you have to mention
 * this at the last. When I click on it again, the same pop-up which opens when I click on the
 * research button on bookmarks has to open and follow the same steps."
 *
 * So two things live here:
 *  - a cheap pass that FLAGS the stories worth a proper dig — significant but thin: a big claim
 *    with few details, no numbers, no source;
 *  - the same research path bookmarks use, pointed at a news story. It creates a JOB inside
 *    Research Agent (created, not started — the owner presses Run) and the report saves as a
 *    Document, exactly as it does from a bookmark.
 *
 * The AI's picks are never the only way in: every story on the page gets its own research button,
 * because the owner asked not to be limited to what the model noticed.
 */

export type FlagOutcome = {
  ok: boolean;
  issueId: string;
  considered: number;
  flagged: number;
  message?: string;
};

/** Never flag more than this — a "worth digging into" list of thirty is not a list. */
const MAX_FLAGGED = 6;
const SNIPPET = 500;
const TOKENS = 500;

@Injectable()
export class NewsResearchService {
  private readonly log = new Logger('NewsResearch');

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly areas?: AgentAreasService,
    private readonly agentSvc?: AgentService,
  ) {}

  /** The marker stitched into a run's input, so past research finds its story again. */
  private researchTag(id: string): string {
    return `[news-story:${id}]`;
  }

  /**
   * Flag the stories worth a proper dig.
   *
   * Failing to flag anything is a perfectly fine outcome and never an error: some days genuinely
   * have nothing that needs chasing. What must not happen is a silent failure that looks like a
   * quiet day, so a model failure is reported in the result.
   */
  async flagIssue(issueId: string): Promise<FlagOutcome> {
    const stories = await this.prisma.newsStory.findMany({
      where: { issueId, kind: 'story' },
      orderBy: { order: 'asc' },
      select: { id: true, text: true, category: true },
    });
    if (!stories.length) {
      return { ok: false, issueId, considered: 0, flagged: 0, message: 'this issue has no stories yet — split it first' };
    }

    const template = await this.prompts.get('news.flagResearch');
    const numbered = stories
      .map((s, i) => `${i + 1}. [${s.category || 'Uncategorised'}] ${s.text.replace(/\s+/g, ' ').slice(0, SNIPPET)}`)
      .join('\n\n');

    let picks: number[];
    try {
      const out = await this.llm.completeHelper('news-flag', `${template}\n\nThe stories:\n\n${numbered}`, TOKENS, 'news-flag');
      if (!out) throw new Error('the model returned nothing');
      picks = this.parsePicks(out, stories.length);
    } catch (e: any) {
      this.log.error(`flagging issue ${issueId} failed: ${e?.message || e}`);
      return {
        ok: false,
        issueId,
        considered: stories.length,
        flagged: 0,
        message: `could not work out what is worth researching (${e?.message || e}) — every story still has its own research button`,
      };
    }

    // Clear and re-set together, and ONLY once we have a good answer. Clearing before the model
    // call meant a rate limit or a network blip wiped a perfectly good shortlist — leaving an
    // edition showing nothing to chase, indistinguishable from a genuinely quiet day.
    const ids = picks.slice(0, MAX_FLAGGED).map((n) => stories[n - 1].id);
    await this.replaceFlags(issueId, ids);

    return { ok: true, issueId, considered: stories.length, flagged: ids.length };
  }

  /**
   * Swap one issue's flags for a new set, in a single transaction where one is available. A crash
   * between the clear and the set would otherwise leave the edition with no shortlist at all.
   */
  private async replaceFlags(issueId: string, ids: string[]): Promise<void> {
    const run = (this.prisma as any).$transaction;
    const work = async (tx: any) => {
      await tx.newsStory.updateMany({ where: { issueId, kind: 'story' }, data: { flagged: false } });
      if (ids.length) await tx.newsStory.updateMany({ where: { id: { in: ids } }, data: { flagged: true } });
    };
    if (typeof run !== 'function') return work(this.prisma);
    await run.call(this.prisma, work);
  }

  /** Pull story numbers out of a reply, dropping anything outside the list. */
  private parsePicks(out: string, total: number): number[] {
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
    const raw = Array.isArray(data?.research) ? data.research : [];
    const seen = new Set<number>();
    const out2: number[] = [];
    for (const v of raw) {
      const n = Number(v);
      // A number outside the list is the model's mistake; flagging the wrong story is worse than
      // flagging none.
      if (!Number.isInteger(n) || n < 1 || n > total || seen.has(n)) continue;
      seen.add(n);
      out2.push(n);
    }
    return out2;
  }

  /** The stories flagged for this issue, in the order they appeared. */
  async flaggedFor(issueId: string) {
    return this.prisma.newsStory.findMany({
      where: { issueId, kind: 'story', flagged: true },
      orderBy: { order: 'asc' },
      select: { id: true, text: true, category: true, sourceKind: true, links: true, theme: true },
    });
  }

  /**
   * Research one news story — the same steps as a bookmark: a JOB inside Research Agent, created
   * but NOT started, and the report saved as a Document.
   */
  async research(storyId: string, question: string): Promise<{ ok: boolean; jobId?: string; areaId?: string; url?: string; message?: string }> {
    const q = String(question || '').trim();
    if (!q) return { ok: false, message: 'Tell me what you want to research first' };

    const story = await this.prisma.newsStory.findUnique({ where: { id: storyId } });
    if (!story) return { ok: false, message: 'Story not found' };
    if (!this.areas || !this.agentSvc) {
      return { ok: false, message: 'The Research Agent is not available right now' };
    }

    const links: string[] = (() => {
      try {
        const a = JSON.parse(story.links || '[]');
        return Array.isArray(a) ? a.slice(0, 6) : [];
      } catch {
        return [];
      }
    })();

    const shortTitle = (story.theme || story.text).replace(/\s+/g, ' ').slice(0, 80);
    const prompt =
      `${this.researchTag(storyId)} Research request about one story from Sandeep's AI News Daily.\n\n` +
      `Category: ${story.category || 'Uncategorised'}\n` +
      (story.theme ? `Theme: ${story.theme}\n` : '') +
      `What the news said:\n${story.text.replace(/\s+/g, ' ').slice(0, 2000)}\n` +
      (links.length ? `\nLinks from the story:\n${links.map((l) => `- ${l}`).join('\n')}\n` : '') +
      `\nSandeep asks, in his own words:\n"${q.slice(0, 2000)}"\n\n` +
      `Do real research: read those links and search the web as needed, cross-check what you find, ` +
      `and write a clear plain-English report (short words, short sentences) with sources at the end. ` +
      `Save the report as a document titled "Research: ${shortTitle}".`;

    const { id: areaId } = await this.areas.ensureResearchAgent();
    const job: any = await this.agentSvc.createAgent({
      areaId,
      name: `Research: ${shortTitle.slice(0, 90)}`,
      icon: '🔬',
      description: q.slice(0, 200),
      prompt,
      autonomy: 'balanced',
    } as any);
    return { ok: true, jobId: job.id, areaId, url: `/agent/a/${job.id}` };
  }

  /** Past research runs about this story — so research is never lost. */
  async researchRuns(storyId: string) {
    const runs = await this.prisma.agentRun.findMany({
      where: { input: { contains: this.researchTag(storyId) } },
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
    return { runs: runs.map((r) => ({ id: r.id, title: r.title, status: r.status, startedAt: r.startedAt, outputDocId: r.outputDocId })) };
  }
}
