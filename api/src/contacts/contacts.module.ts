import { Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';
import { LlmModule } from '../llm/llm.module';

@Module({
  imports: [LlmModule],
  controllers: [ContactsController, RemindersController],
  providers: [ContactsService, RemindersService],
  exports: [ContactsService, RemindersService],
})
export class ContactsModule {}
