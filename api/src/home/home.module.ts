import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { DailyModule } from '../daily/daily.module';
import { MemoryModule } from '../memory/memory.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

@Module({
  imports: [TasksModule, DailyModule, MemoryModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
