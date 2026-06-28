import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { SkillsController } from './skills.controller';
import { SkillShareController } from './skill-share.controller';
import { SkillsService } from './skills.service';
import { SkillsImportService } from './skills-import.service';

@Module({
  imports: [MemoryModule],
  controllers: [SkillsController, SkillShareController],
  providers: [SkillsService, SkillsImportService],
  exports: [SkillsService],
})
export class SkillsModule {}
