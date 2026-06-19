import { Module } from '@nestjs/common';
import { AccountabilityController } from './accountability.controller';
import { AccountabilityService } from './accountability.service';

@Module({
  controllers: [AccountabilityController],
  providers: [AccountabilityService],
  exports: [AccountabilityService],
})
export class AccountabilityModule {}
