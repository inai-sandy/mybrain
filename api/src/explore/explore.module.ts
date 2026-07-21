import { Module } from '@nestjs/common';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';
import { MemoryModule } from '../memory/memory.module';
import { LlmModule } from '../llm/llm.module';
import { ConnectorModule } from '../connectors/connector.module';
import { PromptsModule } from '../prompts/prompts.module';

@Module({
  imports: [MemoryModule, LlmModule, ConnectorModule, PromptsModule],
  controllers: [ExploreController],
  providers: [ExploreService],
  exports: [ExploreService],
})
export class ExploreModule {}
