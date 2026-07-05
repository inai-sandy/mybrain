import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { DocumentsModule } from '../documents/documents.module';
import { EmoModule } from '../emo/emo.module';
import { PublicMcpService } from './public-mcp.service';
import { PublicMcpController } from './public-mcp.controller';

/**
 * Public RAG MCP server (BEA-631) — a read-only, token-gated HTTPS MCP endpoint that lets
 * third-party agents search the owner's brain. Reuses MemoryService + DocumentsService.
 */
@Module({
  imports: [MemoryModule, DocumentsModule, EmoModule],
  controllers: [PublicMcpController],
  providers: [PublicMcpService],
})
export class PublicMcpModule {}
