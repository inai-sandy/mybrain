import { Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module';
import { AgentModule } from '../agent/agent.module';
import { HermesModule } from '../hermes/hermes.module';
import { TasksModule } from '../tasks/tasks.module';
import { ContactsModule } from '../contacts/contacts.module';
import { EmoCardsService } from './emo-cards.service';
import { EmoRouterService } from './emo-router.service';
import { EmoCaptureService } from './emo-capture.service';
import { EmoSearchService } from './emo-search.service';
import { EmoTaskService } from './emo-task.service';
import { EmoReminderService } from './emo-reminder.service';
import { EmoController } from './emo.controller';

/** EMO — Voice → Cards. Storage/feed/router/capture + lanes: Search (869), Tasks (866), Reminders (867). */
@Module({
  imports: [VoiceModule, AgentModule, HermesModule, TasksModule, ContactsModule],
  controllers: [EmoController],
  providers: [EmoCardsService, EmoRouterService, EmoCaptureService, EmoSearchService, EmoTaskService, EmoReminderService],
  exports: [EmoCardsService, EmoRouterService],
})
export class EmoModule {}
