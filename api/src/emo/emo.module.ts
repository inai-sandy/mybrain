import { Module } from '@nestjs/common';
import { EmoCardsService } from './emo-cards.service';
import { EmoController } from './emo.controller';

/** EMO — Voice → Cards. Storage foundation (BEA-861) + feed API (862); router (863) builds on this. */
@Module({
  controllers: [EmoController],
  providers: [EmoCardsService],
  exports: [EmoCardsService],
})
export class EmoModule {}
