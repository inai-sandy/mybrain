import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RadarFeedService } from '../news/radar-feed.service';
import { Public } from '../auth/public.decorator';
import { buildTitleCardSvg, svgToPng } from '../documents/documents-og';
import { buildRadarCardSvg } from './radar-card';

/**
 * The share-card image for anything shareable that isn't a document. (BEA-1135)
 * One endpoint instead of one per module: it only needs "is it shared" plus a title.
 * Documents keep their own endpoint because they can also carry an author-supplied og:image.
 */
@Controller('og')
export class OgController {
  // Optional dep LAST (house rule) and ?.-guarded — spec harnesses build controllers positionally.
  constructor(
    private readonly prisma: PrismaService,
    private readonly radar?: RadarFeedService,
  ) {}

  /** One render per window, not per crawler — the card only changes when the hot list does. */
  private radarCardCache: { at: number; png: Buffer } | null = null;

  /**
   * The public AI News Daily card — today's hot list, drawn fresh. (BEA-1326)
   * Unauthenticated and CPU-bound (a Resvg render), so it is throttled like the other public
   * surfaces AND memoised in-process for 5 minutes: link unfurlers hit this once per share.
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('radar/card.png')
  async radarCard(@Res() res: Response) {
    try {
      const FIVE_MIN = 5 * 60 * 1000;
      if (!this.radarCardCache || Date.now() - this.radarCardCache.at >= FIVE_MIN) {
        const headlines = (await this.radar?.hotTitles(3)) || [];
        const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        this.radarCardCache = { at: Date.now(), png: svgToPng(buildRadarCardSvg({ date, headlines })) };
      }
      res.setHeader('Content-Type', 'image/png');
      // One hour, not a day: the hot list turns over hourly and a stale card is yesterday's news.
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(this.radarCardCache.png);
    } catch {
      res.redirect(302, '/og-default.png');
    }
  }

  /** Title + type label for a shared thing, or null when it isn't shared (never leak a title). */
  private async card(type: string, id: string): Promise<{ title: string; label: string } | null> {
    if (type === 'skill') {
      const s = await this.prisma.skill.findUnique({ where: { id } }).catch(() => null);
      return s?.shared ? { title: s.title || 'Shared skill', label: 'Skill' } : null;
    }
    if (type === 'meeting') {
      const m = await this.prisma.meeting.findUnique({ where: { id } }).catch(() => null);
      return m?.shared ? { title: m.title || 'Shared meeting', label: 'Meeting' } : null;
    }
    if (type === 'item') {
      const it = await this.prisma.item.findUnique({ where: { id } }).catch(() => null);
      return it?.shared ? { title: it.title || 'Shared item', label: 'Bookmark' } : null;
    }
    return null;
  }

  @Public()
  @Get(':type/:id/card.png')
  async image(@Param('type') type: string, @Param('id') id: string, @Res() res: Response) {
    const c = await this.card(type, id);
    // Not shared, unknown type, or the render failed → the static default card. Never a 500,
    // because a broken image is what a recipient would see.
    if (!c) return res.redirect(302, '/og-default.png');
    try {
      const png = svgToPng(buildTitleCardSvg({ title: c.title, label: c.label }));
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(png);
    } catch {
      res.redirect(302, '/og-default.png');
    }
  }
}
