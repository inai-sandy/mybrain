import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

/**
 * Agent feature — the My Brain "shell" around the Hermes engine.
 * BEA-619 ships the durable HITL engine (runs + waitpoints). Later issues add the
 * Hermes bridge (618), the MCP server (622), the live run screen (621) and more.
 * AgentService is exported so those modules can inject it.
 */
@Module({
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
