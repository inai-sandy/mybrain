import { Module } from '@nestjs/common';
import { GoogleService } from './google.service';
import { GmailBriefService } from './gmail-brief.service';
import { GmailRequestService } from './gmail-request.service';
import { EmailMemoryService } from './email-memory.service';
import { GoogleController } from './google.controller';
import { ItemsModule } from '../items/items.module';
import { MemoryModule } from '../memory/memory.module';
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [ItemsModule, MemoryModule, TasksModule],
  providers: [GoogleService, GmailBriefService, GmailRequestService, EmailMemoryService],
  controllers: [GoogleController],
  exports: [GoogleService, GmailBriefService],
})
export class GoogleModule {}
