import { Module } from '@nestjs/common';
import { HermesClient } from './hermes.client';
import { HermesBridgeService } from './hermes-bridge.service';
import { AgentScheduler } from './agent-scheduler.service';
import { HermesController } from './hermes.controller';
import { AgentModule } from '../agent/agent.module';
import { DocumentsModule } from '../documents/documents.module';
import { TelegramModule } from '../telegram/telegram.module';

/**
 * Hermes bridge (BEA-618) — connects My Brain to the Hermes engine over its WS JSON-RPC API,
 * mirrors runs into our AgentRun (BEA-619) and saves outputs into Documents (BEA-622).
 */
@Module({
  imports: [AgentModule, DocumentsModule, TelegramModule],
  controllers: [HermesController],
  providers: [HermesClient, HermesBridgeService, AgentScheduler],
  exports: [HermesClient, HermesBridgeService],
})
export class HermesModule {}
