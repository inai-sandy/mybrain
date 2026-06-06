import { Global, Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { LlmController } from './llm.controller';

@Global()
@Module({
  controllers: [LlmController],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
