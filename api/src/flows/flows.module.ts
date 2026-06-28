import { Module } from '@nestjs/common';
import { SkillsModule } from '../skills/skills.module';
import { LlmModule } from '../llm/llm.module';
import { FlowsService } from './flows.service';
import { FlowsController } from './flows.controller';

/** Flow canvas (Phase 2, BEA-644) — saved visual flows + the node palette + question decompose. */
@Module({
  imports: [SkillsModule, LlmModule],
  controllers: [FlowsController],
  providers: [FlowsService],
})
export class FlowsModule {}
