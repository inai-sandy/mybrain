import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NewsFeedService } from './news-feed.service';
import { NewsSplitService } from './news-split.service';
import { NewsCategoriseService } from './news-categorise.service';
import { NewsWriteService } from './news-write.service';
import { NewsResearchService } from './news-research.service';
import { NewsPipelineService } from './news-pipeline.service';
import { NewsAgentService } from './news-agent.service';
import { NewsReadService } from './news-read.service';
import { NewsPublicService } from './news-public.service';
import { RadarFeedService } from './radar-feed.service';
import { Public } from '../auth/public.decorator';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

@Controller('news')
export class NewsController {
  constructor(
    private readonly feed: NewsFeedService,
    private readonly split: NewsSplitService,
    private readonly categorise: NewsCategoriseService,
    private readonly write: NewsWriteService,
    private readonly research: NewsResearchService,
    private readonly pipeline: NewsPipelineService,
    private readonly agent: NewsAgentService,
    private readonly read: NewsReadService,
    private readonly pub: NewsPublicService,
    private readonly radar: RadarFeedService,
  ) {}

  /** The Radar view's list — always English, paginated, filtered. (BEA-1311) */
  @Get('radar')
  radarList(
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('source') source?: string,
    @Query('picks') picks?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.radar.list({
      search, category, source,
      picksOnly: picks === '1' || picks === 'true',
      sort: sort === 'score' ? 'score' : 'time',
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 20,
    });
  }

  /** Sync state + filter values for the Radar view. (BEA-1311) */
  @Get('radar/status')
  radarStatus() {
    return this.radar.status();
  }

  /** Per-feed health for the Sources strip. (BEA-1311) */
  @Get('radar/sources')
  radarSources() {
    return this.radar.sourceHealth();
  }

  /** Sync now instead of waiting for the hourly poll. (BEA-1311) */
  @Post('radar/sync')
  radarSync() {
    return this.radar.sync();
  }

  /** Pull the feed now instead of waiting for the hourly poll. (BEA-1254) */
  @Post('poll')
  poll() {
    return this.feed.poll();
  }

  /** Issues we hold that an edition can actually be built from, newest first. */
  @Get('issues')
  issues(@Query('take') take?: string) {
    // `?take=abc` would otherwise reach Prisma as NaN and come back as a raw 500.
    const n = Number(take);
    const safe = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : 30;
    return this.feed.usableIssues(safe);
  }

  /** Split every stored issue that has content and has not been split yet. (BEA-1255) */
  @Post('split')
  splitPending() {
    return this.split.splitPending();
  }

  /** Re-split one issue — safe to repeat, it replaces that issue's rows. (BEA-1255) */
  @Post('issues/:id/split')
  splitOne(@Param('id') id: string) {
    return this.split.splitOne(id);
  }

  /** Sort one issue's stories into the eight fixed categories. (BEA-1256) */
  @Post('issues/:id/categorise')
  categoriseOne(@Param('id') id: string) {
    return this.categorise.categoriseIssue(id);
  }

  /** How one issue's stories are spread across the categories. (BEA-1256) */
  @Get('issues/:id/breakdown')
  breakdown(@Param('id') id: string) {
    return this.categorise.breakdown(id);
  }

  /** Write and store one issue's edition — Codex writes the words. (BEA-1257) */
  @Post('issues/:id/write')
  writeEdition(@Param('id') id: string) {
    return this.write.publishEdition(id);
  }

  // ---- Public. No login. Deliberately a separate, narrower shape. (BEA-1261) -------------------

  /**
   * Editions anyone may read, newest first.
   *
   * Rate-limited because this is the first ANONYMOUS surface in the app and it is meant to be
   * shared widely — every other public route here opts in the same way. Generous enough that a
   * real reader never notices, tight enough that a scraper does.
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('public/editions')
  publicIndex(@Query('limit') limit?: string) {
    const n = Number(limit);
    return this.pub.index(Number.isFinite(n) && n > 0 ? Math.floor(n) : 60);
  }

  /** One public edition — no story ids, no shortlist, nothing personal. */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('public/editions/:day')
  publicEdition(@Param('day') day: string) {
    return this.pub.byDay(day);
  }

  /** Every edition, newest first — the archive. (BEA-1260) */
  @Get('editions')
  editions(@Query('limit') limit?: string) {
    const n = Number(limit);
    return this.read.list(Number.isFinite(n) && n > 0 ? Math.floor(n) : 60);
  }

  /** The newest edition's day, so the page knows where to land. (BEA-1260) */
  @Get('editions/latest')
  latest() {
    return this.read.latestDay().then((day) => ({ day }));
  }

  /** One whole edition — every story, under its category. (BEA-1260) */
  @Get('editions/:day')
  edition(@Param('day') day: string) {
    return this.read.byDay(day);
  }

  /** Create (or repair) the AI News Daily agent, its job and its locked, scheduled flow. (BEA-1259) */
  @Post('setup')
  setup() {
    return this.agent.ensure();
  }

  /** Run the whole daily pipeline now, exactly as the noon schedule does. (BEA-1259) */
  @Post('run')
  runDaily() {
    return this.pipeline.runDaily().then((report) => ({ ok: true, report }));
  }

  /** Pick the stories worth digging into. (BEA-1258) */
  @Post('issues/:id/flag')
  flag(@Param('id') id: string) {
    return this.research.flagIssue(id);
  }

  /** The stories flagged as worth digging into. (BEA-1258) */
  @Get('issues/:id/flagged')
  flagged(@Param('id') id: string) {
    return this.research.flaggedFor(id);
  }

  /** Start researching one news story — same steps as a bookmark. (BEA-1258) */
  @Post('stories/:id/research')
  async researchStory(@Param('id') id: string, @Body() body: { question?: string }) {
    const res = await this.research.research(id, body?.question || '');
    if (!res.ok) throw new BadRequestException(res.message || 'Could not start the research');
    return res;
  }

  /** Past research about one story. (BEA-1258) */
  @Get('stories/:id/research')
  researchRuns(@Param('id') id: string) {
    return this.research.researchRuns(id);
  }

  /** The pieces of one issue, in the order they appeared. `?kind=story` for just the news. */
  @Get('issues/:id/stories')
  stories(@Param('id') id: string, @Query('kind') kind?: string) {
    return this.split.storiesFor(id, kind || undefined);
  }
}
