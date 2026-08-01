import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NewsController } from './news.controller';
import { NewsFeedService } from './news-feed.service';

/** AI News Daily (BEA-1254 →). Fetch and store first; splitting, sorting and writing follow. */
@Module({
  imports: [PrismaModule],
  controllers: [NewsController],
  providers: [NewsFeedService],
  exports: [NewsFeedService],
})
export class NewsModule {}
