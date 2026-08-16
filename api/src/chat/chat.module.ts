import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ToolCatalogModule } from '../tools/tool-catalog.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatToolsService } from './chat-tools.service';

@Module({
  // ToolCatalogModule brings the one tool catalog and the service runner, so Chat can act on the
  // services the owner has connected (BEA-1349).
  imports: [MemoryModule, ToolCatalogModule],
  controllers: [ChatController],
  providers: [ChatService, ChatToolsService],
  exports: [ChatService],
})
export class ChatModule {}
