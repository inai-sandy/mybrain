import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MindIngestionService } from './ingestion.service';
import { MentalModelService } from './mentalmodel.service';
import { MindLifecycleService } from './lifecycle.service';
import { MindReviewService } from './review.service';
import { MindStatsService } from './stats.service';
import { MindController } from './mind.controller';

// "The Lab" — the mini mental model. Ingestion + engine + lifecycle + review + stats (446–455).
@Module({
  imports: [LlmModule],
  providers: [MindIngestionService, MentalModelService, MindLifecycleService, MindReviewService, MindStatsService],
  controllers: [MindController],
  exports: [MindIngestionService, MentalModelService, MindLifecycleService, MindReviewService, MindStatsService],
})
export class MindModule {}
