import { Module } from '@nestjs/common';
import { ToolCatalogModule } from '../tools/tool-catalog.module';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';

/**
 * Social (BEA-1356) — the section where social data gets USED. It sits above the tool catalog
 * (which owns the provider and the run path) and is imported by nobody. Design: `specs/SOCIAL.md`.
 */
@Module({
  imports: [ToolCatalogModule], // PrismaModule is @Global
  controllers: [SocialController],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
