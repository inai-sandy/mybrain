import { Module } from '@nestjs/common';
import { ItemsService } from './items.service';
import { ItemsController } from './items.controller';
import { NotionService } from './notion.service';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  controllers: [ItemsController],
  providers: [ItemsService, NotionService],
})
export class ItemsModule {}
