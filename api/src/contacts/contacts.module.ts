import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';
import { PostboxService } from './postbox.service';
import { ReminderSenderService } from './reminder-sender.service';
import { ReminderAgentService } from './reminder-agent.service';
import { PostboxCallbackController } from './postbox-callback.controller';
import { LlmModule } from '../llm/llm.module';
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [LlmModule, TasksModule],
  controllers: [ContactsController, RemindersController, PostboxCallbackController],
  providers: [ContactsService, RemindersService, PostboxService, ReminderSenderService, ReminderAgentService],
  exports: [ContactsService, RemindersService, PostboxService],
})
export class ContactsModule {}
