import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';

/** OAuth 2.1 authorization server for the public MCP connector (BEA-758). */
@Module({
  imports: [AuthModule],
  controllers: [OAuthController],
  providers: [OAuthService],
  exports: [OAuthService],
})
export class OAuthModule {}
