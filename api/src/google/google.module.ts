import { Module, forwardRef } from '@nestjs/common';
import { GoogleService } from './google.service';
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
  // ToolCatalogModule brings the ServiceProvider seam; it still imports us for the catalog's Google
  // probe while the bridge exists, hence forwardRef on both sides (goes with the bridge).
  imports: [ItemsModule, MemoryModule, TasksModule, DocumentsModule, forwardRef(() => ToolCatalogModule)],
  providers: [GoogleService, GoogleWorkspaceService, GmailBriefService, GmailRequestService, EmailMemoryService],
  controllers: [GoogleController],
  exports: [GoogleService, GoogleWorkspaceService, GmailBriefService],
})
export class GoogleModule {}
