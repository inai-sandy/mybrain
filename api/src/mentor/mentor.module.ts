import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { MindModule } from '../mind/mind.module';
import { PushModule } from '../push/push.module'; // for the Lab's one line a week (BEA-1144)
import { MentorController } from './mentor.controller';
import { MentorService } from './mentor.service';

@Module({
  imports: [TasksModule, MindModule, PushModule],
  controllers: [MentorController],
  providers: [MentorService],
  exports: [MentorService],
})
export class MentorModule {}
