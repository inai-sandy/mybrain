import { Module } from '@nestjs/common';
import { GmailBriefService } from './gmail-brief.service';
import { GmailRequestService } from './gmail-request.service';
import { EmailMemoryService } from './email-memory.service';
import { GoogleController } from './google.controller';
import { ItemsModule } from '../items/items.module';
import { MemoryModule } from '../memory/memory.module';
import { TasksModule } from '../tasks/tasks.module';
import { DocumentsModule } from '../documents/documents.module';
import { ToolCatalogModule } from '../tools/tool-catalog.module';
import { GoogleWorkspaceService } from './google-workspace.service';

@Module({
  // ToolCatalogModule brings the ServiceProvider seam every Google read goes through (BEA-1351).
  imports: [ItemsModule, MemoryModule, TasksModule, DocumentsModule, ToolCatalogModule],
  providers: [GoogleWorkspaceService, GmailBriefService, GmailRequestService, EmailMemoryService],
  controllers: [GoogleController],
  exports: [GoogleWorkspaceService, GmailBriefService],
})
export class GoogleModule {}
