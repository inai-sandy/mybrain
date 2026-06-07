import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { SkillsController } from './skills.controller';
import { SkillShareController } from './skill-share.controller';
import { SkillsService } from './skills.service';

@Module({
  imports: [MemoryModule],
  controllers: [SkillsController, SkillShareController],
  providers: [SkillsService],
  exports: [SkillsService],
})
export class SkillsModule {}
