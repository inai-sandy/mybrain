import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NewsController } from './news.controller';
import { NewsFeedService } from './news-feed.service';
import { NewsSplitService } from './news-split.service';

/** AI News Daily (BEA-1254 →). Fetch and store, then split; sorting and writing follow. */
@Module({
  imports: [PrismaModule],
  controllers: [NewsController],
  providers: [NewsFeedService, NewsSplitService],
  exports: [NewsFeedService, NewsSplitService],
})
export class NewsModule {}
