import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { ClaimsService } from './claims.service';
import { TaskHealthService } from './task-health.service';
import { RecurringService } from './recurring.service';
import { MemoryModule } from '../memory/memory.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [MemoryModule, TelegramModule], // Telegram: the nightly health check speaks to the owner (BEA-1190)
  controllers: [TasksController],
  providers: [TaskHealthService, TasksService, ClaimsService, RecurringService],
  exports: [TasksService, ClaimsService, RecurringService],
})
export class TasksModule {}
