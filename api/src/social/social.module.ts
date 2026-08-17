import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { DocumentsModule } from '../documents/documents.module';
import { PushModule } from '../push/push.module';
import { ToolCatalogModule } from '../tools/tool-catalog.module';
import { SocialAgentRunService } from './social-agent-run.service';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';

/**
 * Social (BEA-1356) — the section where social data gets USED. It sits above the tool catalog
 * (which owns the provider and the run path). Design: `specs/SOCIAL.md`.
 *
 * `SocialAgentRunService` (BEA-1357) is the direct runner for a Social agent's run — imported by
 * HermesModule, which forks to it before an engine turn would start. No cycle: none of the modules
 * here import Hermes.
 */
@Module({
  imports: [ToolCatalogModule, AgentModule, DocumentsModule, PushModule], // PrismaModule + LlmModule are @Global
  controllers: [SocialController],
  providers: [SocialService, SocialAgentRunService],
  exports: [SocialService, SocialAgentRunService],
})
export class SocialModule {}
