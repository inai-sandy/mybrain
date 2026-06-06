import { Module } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { MemoryController } from './memory.controller';
import { SuperMemoryStore } from './supermemory.store';
import { RagStore } from './rag.store';

@Module({
  controllers: [MemoryController],
  providers: [MemoryService, SuperMemoryStore, RagStore],
  exports: [MemoryService],
})
export class MemoryModule {}
