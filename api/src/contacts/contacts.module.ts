import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';
import { PostboxService } from './postbox.service';
import { ReminderSenderService } from './reminder-sender.service';
import { PostboxCallbackController } from './postbox-callback.controller';
import { LlmModule } from '../llm/llm.module';

@Module({
  imports: [LlmModule],
  controllers: [ContactsController, RemindersController, PostboxCallbackController],
  providers: [ContactsService, RemindersService, PostboxService, ReminderSenderService],
  exports: [ContactsService, RemindersService, PostboxService],
})
export class ContactsModule {}
