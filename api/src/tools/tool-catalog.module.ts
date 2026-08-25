import { Module } from '@nestjs/common';
import { ConnectorModule } from '../connectors/connector.module';
import { SkillsModule } from '../skills/skills.module';
import { ToolCatalogService } from './tool-catalog.service';
import { WebResearchService } from './web-research.service';
import { DeepResearchService } from './deep-research.service';
import { ComposioProvider } from './composio.provider';
import { ScrapeCreatorsProvider } from './scrapecreators.provider';
import { WhatsAppProvider } from './whatsapp.provider';
import { ServiceActionsService } from './service-actions.service';
import { ToolLessonService } from './tool-lesson.service';
import { ToolLookupService } from './tool-lookup.service';
import { ToolDocsService } from './tool-doc.service';
import { ServiceGatesService } from './service-gates.service';
import { ToolCatalogController } from './tool-catalog.controller';
import { ServicesController } from './services.controller';
import { ToolDocsController } from './tool-docs.controller';
import { ToolKnowledgeService } from './tool-knowledge.service';
import { ToolKnowledgeController } from './tool-knowledge.controller';
import { ToolSampleService } from './tool-sample.service';

/** The single grouped tool catalog (BEA-1167) — agents, the builder chat and the flow canvas all read it. */
@Module({
  imports: [ConnectorModule, SkillsModule], // LlmModule and PrismaModule are @Global
  controllers: [ToolCatalogController, ServicesController, ToolKnowledgeController, ToolDocsController],
  providers: [ToolLessonService, ToolLookupService, ToolDocsService, ToolCatalogService, ToolSampleService, WebResearchService, DeepResearchService, ComposioProvider, ScrapeCreatorsProvider, WhatsAppProvider, ServiceGatesService, ServiceActionsService, ToolKnowledgeService],
  exports: [ToolLessonService, ToolLookupService, ToolDocsService, ToolCatalogService, ToolSampleService, WebResearchService, DeepResearchService, ComposioProvider, ScrapeCreatorsProvider, WhatsAppProvider, ServiceGatesService, ServiceActionsService, ToolKnowledgeService],
})
export class ToolCatalogModule {}
