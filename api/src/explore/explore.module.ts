import { Module } from '@nestjs/common';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';
import { MemoryModule } from '../memory/memory.module';
import { LlmModule } from '../llm/llm.module';

@Module({
  imports: [MemoryModule, LlmModule],
  controllers: [ExploreController],
  providers: [ExploreService],
})
export class ExploreModule {}
