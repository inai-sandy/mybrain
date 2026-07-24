import { Module } from '@nestjs/common';
import { PushService } from './push.service';
import { PushController } from './push.controller';

/** Web Push (BEA-1088) — phone notifications from the PWA. Depends only on Prisma; safe to import anywhere. */
@Module({
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
