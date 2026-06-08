import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { DailyModule } from '../daily/daily.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

@Module({
  imports: [TasksModule, DailyModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
