import { Module } from '@nestjs/common';
import { FlowsModule } from '../flows/flows.module';
import { TelegramModule } from '../telegram/telegram.module';
import { ToolCatalogModule } from '../tools/tool-catalog.module';
import { TriggersController } from './triggers.controller';
import { TriggersService } from './triggers.service';

/**
 * Triggers (BEA-1350) — a service event starts a flow.
 *
 * Its own module rather than a corner of the tool catalog, and that is forced rather than chosen:
 * `FlowsModule` already imports `ToolCatalogModule` (a flow step runs a service action), so putting
 * the flow runner inside the tool catalog would be a cycle. This module sits above both and is
 * imported by nobody, which is why there is no cycle here either.
 */
@Module({
  imports: [FlowsModule, ToolCatalogModule, TelegramModule], // PrismaModule is @Global
  controllers: [TriggersController],
  providers: [TriggersService],
  exports: [TriggersService],
})
export class TriggersModule {}
