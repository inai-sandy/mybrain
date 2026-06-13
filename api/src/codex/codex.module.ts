import { Module } from '@nestjs/common';
import { CodexController } from './codex.controller';
import { CodexService } from './codex.service';

@Module({
  controllers: [CodexController],
  providers: [CodexService],
  exports: [CodexService],
})
export class CodexModule {}
