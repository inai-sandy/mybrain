import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { ClaimsService } from './claims.service';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  controllers: [TasksController],
  providers: [TasksService, ClaimsService],
  exports: [TasksService, ClaimsService],
})
export class TasksModule {}
