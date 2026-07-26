import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/public.decorator';
import { buildTitleCardSvg, svgToPng } from '../documents/documents-og';

/**
 * The share-card image for anything shareable that isn't a document. (BEA-1135)
 * One endpoint instead of one per module: it only needs "is it shared" plus a title.
 * Documents keep their own endpoint because they can also carry an author-supplied og:image.
 */
@Controller('og')
export class OgController {
  constructor(private readonly prisma: PrismaService) {}

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
