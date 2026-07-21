import { Module } from '@nestjs/common';
import { BriefingsController } from './briefings.controller';
import { BriefingsService } from './briefings.service';
import { TasksModule } from '../tasks/tasks.module';
import { LlmModule } from '../llm/llm.module';
import { ContactsModule } from '../contacts/contacts.module';

@Module({
  imports: [TasksModule, LlmModule, ContactsModule],
  controllers: [BriefingsController],
  providers: [BriefingsService],
  exports: [BriefingsService],
})
export class BriefingsModule {}
