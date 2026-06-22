import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MindIngestionService } from './ingestion.service';
import { MentalModelService } from './mentalmodel.service';
import { MindController } from './mind.controller';

// "The Lab" — the mini mental model. P1 ingestion (BEA-446) + P2 reasoning engine (BEA-447).
@Module({
  imports: [LlmModule],
  providers: [MindIngestionService, MentalModelService],
  controllers: [MindController],
  exports: [MindIngestionService, MentalModelService],
})
export class MindModule {}
