import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ItemsModule } from '../items/items.module';
import { IdeasController } from './ideas.controller';
import { IdeasService } from './ideas.service';

@Module({
  imports: [MemoryModule, ItemsModule],
  controllers: [IdeasController],
  providers: [IdeasService],
  exports: [IdeasService],
})
export class IdeasModule {}
