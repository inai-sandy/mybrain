import { Module } from '@nestjs/common';
import { MindIngestionService } from './ingestion.service';

// "The Lab" — the mini mental model. P1 = signal ingestion. (BEA-446)
@Module({
  providers: [MindIngestionService],
  exports: [MindIngestionService],
})
export class MindModule {}
