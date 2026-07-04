import { Module } from '@nestjs/common';
import { EmoCardsService } from './emo-cards.service';
import { EmoRouterService } from './emo-router.service';
import { EmoController } from './emo.controller';

/** EMO — Voice → Cards. Storage (861) + feed API (862) + AI intent router (863). Lanes build on this. */
@Module({
  controllers: [EmoController],
  providers: [EmoCardsService, EmoRouterService],
  exports: [EmoCardsService, EmoRouterService],
})
export class EmoModule {}
