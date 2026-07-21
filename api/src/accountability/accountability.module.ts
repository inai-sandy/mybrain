import { Module } from '@nestjs/common';
import { AccountabilityController } from './accountability.controller';
import { AccountabilityService } from './accountability.service';

import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [TasksModule],
  controllers: [AccountabilityController],
  providers: [AccountabilityService],
  exports: [AccountabilityService],
})
export class AccountabilityModule {}
