import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ConnectorModule } from './connectors/connector.module';
import { MemoryModule } from './memory/memory.module';
import { ItemsModule } from './items/items.module';
import { BookmarksModule } from './bookmarks/bookmarks.module';
import { LlmModule } from './llm/llm.module';

@Module({
  imports: [PrismaModule, AuthModule, ConnectorModule, LlmModule, MemoryModule, ItemsModule, BookmarksModule],
  controllers: [HealthController],
})
export class AppModule {}
