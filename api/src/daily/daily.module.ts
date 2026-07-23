import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { TasksModule } from '../tasks/tasks.module';
import { MentorModule } from '../mentor/mentor.module';
import { MindModule } from '../mind/mind.module';
import { ContactsModule } from '../contacts/contacts.module';
import { StoryMiningService } from './story-mining.service';
import { DailyController } from './daily.controller';
import { DailyService } from './daily.service';

@Module({
  imports: [MemoryModule, TasksModule, MentorModule, MindModule, ContactsModule], // Contacts: delegation chases from mined stories (BEA-1051)
  controllers: [DailyController],
  providers: [DailyService, StoryMiningService],
  exports: [DailyService, StoryMiningService],
})
export class DailyModule {}
