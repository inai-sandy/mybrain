import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';
import { AgentsImportService } from './agents-import.service';
import { AgentAreasService } from './agent-areas.service';
import { BuilderSampleService } from './builder-sample.service';
import { RunLockService } from './run-lock.service';
import { DocumentsModule } from '../documents/documents.module';
import { MemoryModule } from '../memory/memory.module';
import { LlmModule } from '../llm/llm.module';
import { ToolCatalogModule } from '../tools/tool-catalog.module';
import { PromptsModule } from '../prompts/prompts.module';

/**
 * Agent feature — the My Brain "shell" around the Hermes engine.
 * BEA-619: durable HITL engine (runs + waitpoints).
 * BEA-622: the tool capabilities the agent calls (save_document, search_brain, ask_user),
 *          exposed over REST here and over MCP (agent-mcp) for Hermes.
 * Later: the Hermes bridge (618), live run screen (621), schedule/history (623), etc.
 */
@Module({
  imports: [DocumentsModule, MemoryModule, LlmModule, PromptsModule, ToolCatalogModule],
  controllers: [AgentController, AgentToolsController],
  // BuilderSampleService (BEA-1370) runs through ToolCatalogModule's ServiceActionsService; the daily
  // ceiling reaches it through `setBudget()` from SocialModule (which imports this module — no cycle).
  // RunLockService (BEA-1388) needs nothing but Prisma and everything that STARTS a run needs it, so
  // it lives here — the scheduler, the manual routes, the worker road and (later) the repair loop all
  // reach it through this module's exports.
  providers: [AgentService, AgentToolsService, AgentsImportService, AgentAreasService, BuilderSampleService, RunLockService],
  exports: [AgentService, AgentToolsService, AgentsImportService, AgentAreasService, BuilderSampleService, RunLockService],
})
export class AgentModule {}
