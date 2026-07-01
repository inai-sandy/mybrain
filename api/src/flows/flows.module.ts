import { Module } from '@nestjs/common';
import { SkillsModule } from '../skills/skills.module';
import { LlmModule } from '../llm/llm.module';
import { AgentModule } from '../agent/agent.module';
import { HermesModule } from '../hermes/hermes.module';
import { DocumentsModule } from '../documents/documents.module';
import { MemoryModule } from '../memory/memory.module';
import { TelegramModule } from '../telegram/telegram.module';
import { FlowsService } from './flows.service';
import { FlowRunnerService } from './flows-runner.service';
import { FlowScheduler } from './flow-scheduler.service';
import { FlowsController } from './flows.controller';

/** Flow canvas (Phase 2, BEA-644/646) — saved flows, palette, decompose, the graph executor + scheduler. */
@Module({
  imports: [SkillsModule, LlmModule, AgentModule, HermesModule, DocumentsModule, MemoryModule, TelegramModule],
  controllers: [FlowsController],
  providers: [FlowsService, FlowRunnerService, FlowScheduler],
})
export class FlowsModule {}
