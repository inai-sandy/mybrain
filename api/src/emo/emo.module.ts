import { Module } from '@nestjs/common';
import { EmoCardsService } from './emo-cards.service';

/** EMO — Voice → Cards. Storage foundation (BEA-861); feed API/UI (862) and router (863) build on this. */
@Module({
  providers: [EmoCardsService],
  exports: [EmoCardsService],
})
export class EmoModule {}
