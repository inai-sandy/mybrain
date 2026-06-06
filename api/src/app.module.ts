import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ConnectorModule } from './connectors/connector.module';

@Module({
  imports: [PrismaModule, AuthModule, ConnectorModule],
  controllers: [HealthController],
})
export class AppModule {}
