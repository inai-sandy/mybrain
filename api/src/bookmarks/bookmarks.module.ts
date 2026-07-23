import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ItemsModule } from '../items/items.module';
import { HermesModule } from '../hermes/hermes.module';
import { BookmarksController } from './bookmarks.controller';
import { BookmarksService } from './bookmarks.service';
import { SummarizerService } from './summarizer.service';
import { RaindropClient } from './raindrop.client';
import { InstagramEnricher } from './instagram.service';

@Module({
  imports: [MemoryModule, ItemsModule, HermesModule], // ItemsModule: the one true item delete (BEA-1049); HermesModule: research runs (BEA-1047)
  controllers: [BookmarksController],
  providers: [BookmarksService, SummarizerService, RaindropClient, InstagramEnricher],
  exports: [BookmarksService],
})
export class BookmarksModule {}
