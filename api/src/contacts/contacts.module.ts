import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ShareController } from './share.controller';
import { ContactsService } from './contacts.service';
import { TeamUpdatesService } from './team-updates.service';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';
import { PostboxService } from './postbox.service';
import { ReminderSenderService } from './reminder-sender.service';
import { ReminderAgentService } from './reminder-agent.service';
import { PostboxCallbackController } from './postbox-callback.controller';
import { LlmModule } from '../llm/llm.module';
import { TasksModule } from '../tasks/tasks.module';
import { MemoryModule } from '../memory/memory.module';
import { ProfileWriterService } from './profile-writer.service';

@Module({
  imports: [LlmModule, TasksModule, MemoryModule],
  controllers: [ContactsController, ShareController, RemindersController, PostboxCallbackController],
  providers: [ContactsService, TeamUpdatesService, RemindersService, PostboxService, ReminderSenderService, ReminderAgentService, ProfileWriterService],
  exports: [ContactsService, RemindersService, PostboxService, TeamUpdatesService],
})
export class ContactsModule {}
