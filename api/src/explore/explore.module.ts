import { Module } from '@nestjs/common';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';
import { MemoryModule } from '../memory/memory.module';
import { LlmModule } from '../llm/llm.module';
import { ConnectorModule } from '../connectors/connector.module';

@Module({
  imports: [MemoryModule, LlmModule, ConnectorModule],
  controllers: [ExploreController],
  providers: [ExploreService],
  exports: [ExploreService],
})
export class ExploreModule {}
