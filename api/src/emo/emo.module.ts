import { Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module';
import { AgentModule } from '../agent/agent.module';
import { HermesModule } from '../hermes/hermes.module';
import { EmoCardsService } from './emo-cards.service';
import { EmoRouterService } from './emo-router.service';
import { EmoCaptureService } from './emo-capture.service';
import { EmoSearchService } from './emo-search.service';
import { EmoController } from './emo.controller';

/** EMO — Voice → Cards. Storage (861) + feed (862) + router (863) + capture (864) + Search lane (869). */
@Module({
  imports: [VoiceModule, AgentModule, HermesModule],
  controllers: [EmoController],
  providers: [EmoCardsService, EmoRouterService, EmoCaptureService, EmoSearchService],
  exports: [EmoCardsService, EmoRouterService],
})
export class EmoModule {}
