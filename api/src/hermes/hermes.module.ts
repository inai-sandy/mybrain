import { Module } from '@nestjs/common';
import { HermesBridgeService } from './hermes-bridge.service';
import { AgentScheduler } from './agent-scheduler.service';
import { EngineWatchdog } from './engine-watchdog.service';
import { HermesController } from './hermes.controller';
import { AgentModule } from '../agent/agent.module';
import { DocumentsModule } from '../documents/documents.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MemoryModule } from '../memory/memory.module';
import { LlmModule } from '../llm/llm.module';
import { PushModule } from '../push/push.module';

/**
 * Agent engine bridge — runs agent turns on the host Codex (via codex-runner) and mirrors them into
 * our AgentRun + Documents. (Was the Hermes WS bridge; Hermes removed BEA-663/667.)
 */
@Module({
  imports: [AgentModule, DocumentsModule, TelegramModule, MemoryModule, LlmModule, PushModule],
  controllers: [HermesController],
  providers: [HermesBridgeService, AgentScheduler, EngineWatchdog],
  exports: [HermesBridgeService],
})
export class HermesModule {}
