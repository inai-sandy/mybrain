import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { MindModule } from '../mind/mind.module';
import { MentorController } from './mentor.controller';
import { MentorService } from './mentor.service';

@Module({
  imports: [TasksModule, MindModule],
  controllers: [MentorController],
  providers: [MentorService],
  exports: [MentorService],
})
export class MentorModule {}
