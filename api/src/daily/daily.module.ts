import { Module } from '@nestjs/common';
import { DailyController } from './daily.controller';
import { DailyService } from './daily.service';

@Module({
  controllers: [DailyController],
  providers: [DailyService],
  exports: [DailyService],
})
export class DailyModule {}
