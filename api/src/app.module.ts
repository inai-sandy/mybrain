import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ConnectorModule } from './connectors/connector.module';
import { MemoryModule } from './memory/memory.module';

@Module({
  imports: [PrismaModule, AuthModule, ConnectorModule, MemoryModule],
  controllers: [HealthController],
})
export class AppModule {}
