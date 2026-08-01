import { Module } from '@nestjs/common';
import { SkillsModule } from '../skills/skills.module';
import { LlmModule } from '../llm/llm.module';
import { AgentModule } from '../agent/agent.module';
import { HermesModule } from '../hermes/hermes.module';
import { DocumentsModule } from '../documents/documents.module';
import { MemoryModule } from '../memory/memory.module';
import { TelegramModule } from '../telegram/telegram.module';
import { PushModule } from '../push/push.module';
import { ToolCatalogModule } from '../tools/tool-catalog.module';
// Tier-1 tools do their work in-process instead of through a 118k-token engine turn (BEA-1203).
// None of these import FlowsModule, so there is no cycle: Items/Tasks pull in only MemoryModule,
// Contacts pulls in Llm + Tasks. (Only EmoModule imports FlowsModule.)
import { ItemsModule } from '../items/items.module';
import { TasksModule } from '../tasks/tasks.module';
import { ContactsModule } from '../contacts/contacts.module';
// AI News Daily's own steps (BEA-1259). NewsModule does not import FlowsModule, so no cycle.
// This import is REQUIRED, not a nicety: a `?` on the constructor param only helps spec files that
// build the service by hand — Nest still treats it as a hard dependency, and without the module
// here the whole app refuses to start.
import { NewsModule } from '../news/news.module';
import { FlowsService } from './flows.service';
import { FlowRunnerService } from './flows-runner.service';
import { FlowScheduler } from './flow-scheduler.service';
import { FlowsController } from './flows.controller';

/** Flow canvas (Phase 2, BEA-644/646) — saved flows, palette, decompose, the graph executor + scheduler. */
@Module({
  imports: [SkillsModule, LlmModule, AgentModule, HermesModule, DocumentsModule, MemoryModule, TelegramModule, PushModule, ToolCatalogModule, ItemsModule, TasksModule, ContactsModule, NewsModule],
  controllers: [FlowsController],
  providers: [FlowsService, FlowRunnerService, FlowScheduler],
  exports: [FlowsService, FlowRunnerService], // EMO research builds, saves AND runs a flow (BEA-870/1175)
})
export class FlowsModule {}
