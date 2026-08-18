import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ToolKnowledgeService } from './tool-knowledge.service';

/**
 * The know-how cards (BEA-1368): `GET /api/tools/knowledge/:actionId` for one, and
 * `POST /api/tools/knowledge/lookup {ids[]}` for a builder's shortlist (≤ 50 at once). Cached 10
 * minutes inside the service; nothing here touches the catalog's path.
 */
@Controller('tools/knowledge')
export class ToolKnowledgeController {
  constructor(private readonly knowledge: ToolKnowledgeService) {}

  @Post('lookup')
  async lookup(@Body() body: { ids?: string[] }) {
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    const cards = await this.knowledge.lookup(ids);
    return { cards, asked: ids.length, found: cards.length };
  }

  @Get(':actionId')
  async one(@Param('actionId') actionId: string, @Query('fresh') fresh?: string) {
    const card = await this.knowledge.card(actionId, { fresh: fresh === '1' || fresh === 'true' });
    if (!card) throw new NotFoundException(`No card for "${actionId}" — not an action we know.`);
    return card;
  }
}
