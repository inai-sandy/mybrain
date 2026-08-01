import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { PromptsModule } from '../prompts/prompts.module';
import { NewsController } from './news.controller';
import { NewsFeedService } from './news-feed.service';
import { NewsSplitService } from './news-split.service';
import { NewsCategoriseService } from './news-categorise.service';

/** AI News Daily (BEA-1254 →). Fetch, split, categorise; the engine's write-up follows. */
@Module({
  imports: [PrismaModule, LlmModule, PromptsModule],
  controllers: [NewsController],
  providers: [NewsFeedService, NewsSplitService, NewsCategoriseService],
  exports: [NewsFeedService, NewsSplitService, NewsCategoriseService],
})
export class NewsModule {}
