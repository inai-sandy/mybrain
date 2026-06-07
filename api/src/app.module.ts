import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ConnectorModule } from './connectors/connector.module';
import { MemoryModule } from './memory/memory.module';
import { ItemsModule } from './items/items.module';
import { BookmarksModule } from './bookmarks/bookmarks.module';
import { IdeasModule } from './ideas/ideas.module';
import { SkillsModule } from './skills/skills.module';
import { TasksModule } from './tasks/tasks.module';
import { DailyModule } from './daily/daily.module';
import { LlmModule } from './llm/llm.module';

@Module({
  imports: [PrismaModule, AuthModule, ConnectorModule, LlmModule, MemoryModule, ItemsModule, BookmarksModule, IdeasModule, SkillsModule, TasksModule, DailyModule],
  controllers: [HealthController],
})
export class AppModule {}
