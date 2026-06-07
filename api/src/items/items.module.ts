import { Module } from '@nestjs/common';
import { ItemsService } from './items.service';
import { ItemsController } from './items.controller';
import { ShareController } from './share.controller';
import { NotionService } from './notion.service';
import { EnrichmentService } from './enrichment.service';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  controllers: [ItemsController, ShareController],
  providers: [ItemsService, NotionService, EnrichmentService],
})
export class ItemsModule {}
