import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { PromptsModule } from '../prompts/prompts.module';
import { NewsController } from './news.controller';
import { NewsFeedService } from './news-feed.service';
import { NewsSplitService } from './news-split.service';
import { NewsCategoriseService } from './news-categorise.service';
import { NewsWriteService } from './news-write.service';
import { NewsResearchService } from './news-research.service';
import { NewsPipelineService } from './news-pipeline.service';
import { NewsAgentService } from './news-agent.service';
import { NewsReadService } from './news-read.service';
import { NewsPublicService } from './news-public.service';
import { AgentModule } from '../agent/agent.module';

/** AI News Daily (BEA-1254 →). Fetch, split, categorise; the engine's write-up follows. */
@Module({
  imports: [PrismaModule, LlmModule, PromptsModule, AgentModule],
  controllers: [NewsController],
  providers: [NewsFeedService, NewsSplitService, NewsCategoriseService, NewsWriteService, NewsResearchService, NewsPipelineService, NewsAgentService, NewsReadService, NewsPublicService],
  exports: [NewsFeedService, NewsSplitService, NewsCategoriseService, NewsWriteService, NewsResearchService, NewsPipelineService, NewsAgentService, NewsReadService, NewsPublicService],
})
export class NewsModule {}
