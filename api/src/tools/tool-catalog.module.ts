import { Module } from '@nestjs/common';
import { ConnectorModule } from '../connectors/connector.module';
import { SkillsModule } from '../skills/skills.module';
import { GoogleModule } from '../google/google.module';
import { ToolCatalogService } from './tool-catalog.service';
import { WebResearchService } from './web-research.service';
import { DeepResearchService } from './deep-research.service';
import { ToolCatalogController } from './tool-catalog.controller';

/** The single grouped tool catalog (BEA-1167) — agents, the builder chat and the flow canvas all read it. */
@Module({
  imports: [ConnectorModule, SkillsModule, GoogleModule], // LlmModule is @Global
  controllers: [ToolCatalogController],
  providers: [ToolCatalogService, WebResearchService, DeepResearchService],
  exports: [ToolCatalogService, WebResearchService, DeepResearchService],
})
export class ToolCatalogModule {}
