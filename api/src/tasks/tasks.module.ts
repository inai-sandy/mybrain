import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { ClaimsService } from './claims.service';
import { TaskHealthService } from './task-health.service';
import { RecurringService } from './recurring.service';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  controllers: [TasksController],
  providers: [TaskHealthService, TasksService, ClaimsService, RecurringService],
  exports: [TasksService, ClaimsService, RecurringService, TaskHealthService], // the notifier lives in telegram (BEA-1190)
})
export class TasksModule {}
