import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MindIngestionService } from './ingestion.service';
import { MentalModelService } from './mentalmodel.service';
import { MindLifecycleService } from './lifecycle.service';
import { MindReviewService } from './review.service';
import { MindStatsService } from './stats.service';
import { MindChainService } from './chain.service';
import { MindController } from './mind.controller';

// "The Lab" — the mini mental model. Ingestion + engine + lifecycle + review + stats + situation chains.
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [TasksModule, LlmModule],
  providers: [MindIngestionService, MentalModelService, MindLifecycleService, MindReviewService, MindStatsService, MindChainService],
  controllers: [MindController],
  exports: [MindIngestionService, MentalModelService, MindLifecycleService, MindReviewService, MindStatsService, MindChainService],
})
export class MindModule {}
