import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { DocumentsModule } from '../documents/documents.module';
import { PushModule } from '../push/push.module';
import { TelegramModule } from '../telegram/telegram.module';
import { ToolCatalogModule } from '../tools/tool-catalog.module';
import { SocialAgentRunService } from './social-agent-run.service';
import { SocialBudgetService } from './social-budget.service';
import { SocialWatchStore } from './social-watch.store';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';
import { SourceFetchService } from './source-fetch.service';

/**
 * Social (BEA-1356) — the section where social data gets USED. It sits above the tool catalog
 * (which owns the provider and the run path). Design: `specs/SOCIAL.md`.
 *
 * `SocialAgentRunService` (BEA-1357) is the direct runner for a Social agent's run — imported by
 * HermesModule, which forks to it before an engine turn would start. No cycle: none of the modules
 * here import Hermes. `SocialBudgetService` (the daily credit ceiling) and `SocialWatchStore`
 * (what a Watch/Alert saw last time) are BEA-1358; TelegramModule is imported for the "paused
 * itself" and "alert fired" pushes — Telegram → Daily → Mentor → Push, never back here.
 */
@Module({
  imports: [ToolCatalogModule, AgentModule, DocumentsModule, PushModule, TelegramModule], // PrismaModule + LlmModule are @Global
  controllers: [SocialController],
  providers: [SocialService, SocialAgentRunService, SocialBudgetService, SocialWatchStore, SourceFetchService],
  exports: [SocialService, SocialAgentRunService, SocialBudgetService, SocialWatchStore, SourceFetchService],
})
export class SocialModule {}
