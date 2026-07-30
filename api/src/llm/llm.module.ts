import { Global, Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { TokenBudgetService } from './token-budget.service';
import { LlmController } from './llm.controller';

@Global()
@Module({
  controllers: [LlmController],
  providers: [LlmService, TokenBudgetService],
  exports: [LlmService, TokenBudgetService],
})
export class LlmModule {}
