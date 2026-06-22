import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MindIngestionService } from './ingestion.service';
import { MentalModelService } from './mentalmodel.service';
import { MindLifecycleService } from './lifecycle.service';
import { MindReviewService } from './review.service';
import { MindController } from './mind.controller';

// "The Lab" — the mini mental model. Ingestion (446) + engine (447) + lifecycle (448) + review (449).
@Module({
  imports: [LlmModule],
  providers: [MindIngestionService, MentalModelService, MindLifecycleService, MindReviewService],
  controllers: [MindController],
  exports: [MindIngestionService, MentalModelService, MindLifecycleService, MindReviewService],
})
export class MindModule {}
