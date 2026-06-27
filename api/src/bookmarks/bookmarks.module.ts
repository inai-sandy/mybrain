import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { BookmarksController } from './bookmarks.controller';
import { BookmarksService } from './bookmarks.service';
import { SummarizerService } from './summarizer.service';
import { RaindropClient } from './raindrop.client';
import { InstagramEnricher } from './instagram.service';

@Module({
  imports: [MemoryModule],
  controllers: [BookmarksController],
  providers: [BookmarksService, SummarizerService, RaindropClient, InstagramEnricher],
  exports: [BookmarksService],
})
export class BookmarksModule {}
