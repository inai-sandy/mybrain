import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MindIngestionService } from './ingestion.service';
import { MentalModelService } from './mentalmodel.service';
import { MindLifecycleService } from './lifecycle.service';
import { MindController } from './mind.controller';

// "The Lab" — the mini mental model. P1 ingestion (BEA-446) + P2 engine (BEA-447) + P3 lifecycle (BEA-448).
@Module({
  imports: [LlmModule],
  providers: [MindIngestionService, MentalModelService, MindLifecycleService],
  controllers: [MindController],
  exports: [MindIngestionService, MentalModelService, MindLifecycleService],
})
export class MindModule {}
