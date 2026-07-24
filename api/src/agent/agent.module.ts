import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';
import { AgentsImportService } from './agents-import.service';
import { DocumentsModule } from '../documents/documents.module';
import { MemoryModule } from '../memory/memory.module';
import { LlmModule } from '../llm/llm.module';
import { PromptsModule } from '../prompts/prompts.module';

/**
 * Agent feature — the My Brain "shell" around the Hermes engine.
 * BEA-619: durable HITL engine (runs + waitpoints).
 * BEA-622: the tool capabilities the agent calls (save_document, search_brain, ask_user),
 *          exposed over REST here and over MCP (agent-mcp) for Hermes.
 * Later: the Hermes bridge (618), live run screen (621), schedule/history (623), etc.
 */
@Module({
  imports: [DocumentsModule, MemoryModule, LlmModule, PromptsModule],
  controllers: [AgentController, AgentToolsController],
  providers: [AgentService, AgentToolsService, AgentsImportService],
  exports: [AgentService, AgentToolsService, AgentsImportService],
})
export class AgentModule {}
