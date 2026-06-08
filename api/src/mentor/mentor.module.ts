import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { MentorController } from './mentor.controller';
import { MentorService } from './mentor.service';

@Module({
  imports: [TasksModule],
  controllers: [MentorController],
  providers: [MentorService],
  exports: [MentorService],
})
export class MentorModule {}
