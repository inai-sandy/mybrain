import { Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module';
import { EmoCardsService } from './emo-cards.service';
import { EmoRouterService } from './emo-router.service';
import { EmoCaptureService } from './emo-capture.service';
import { EmoController } from './emo.controller';

/** EMO — Voice → Cards. Storage (861) + feed (862) + router (863) + capture pipeline (864). */
@Module({
  imports: [VoiceModule],
  controllers: [EmoController],
  providers: [EmoCardsService, EmoRouterService, EmoCaptureService],
  exports: [EmoCardsService, EmoRouterService],
})
export class EmoModule {}
