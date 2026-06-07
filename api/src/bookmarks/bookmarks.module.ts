import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { BookmarksController } from './bookmarks.controller';
import { BookmarksService } from './bookmarks.service';
import { RaindropClient } from './raindrop.client';
import { TavilyClient } from './tavily.client';

@Module({
  imports: [MemoryModule],
  controllers: [BookmarksController],
  providers: [BookmarksService, RaindropClient, TavilyClient],
  exports: [BookmarksService],
})
export class BookmarksModule {}
