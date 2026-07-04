import { Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module';
import { AgentModule } from '../agent/agent.module';
import { HermesModule } from '../hermes/hermes.module';
import { TasksModule } from '../tasks/tasks.module';
import { ContactsModule } from '../contacts/contacts.module';
import { DailyModule } from '../daily/daily.module';
import { FlowsModule } from '../flows/flows.module';
import { EmoCardsService } from './emo-cards.service';
import { EmoRouterService } from './emo-router.service';
import { EmoCaptureService } from './emo-capture.service';
import { EmoSearchService } from './emo-search.service';
import { EmoTaskService } from './emo-task.service';
import { EmoReminderService } from './emo-reminder.service';
import { EmoStoryService } from './emo-story.service';
import { EmoMeetingService } from './emo-meeting.service';
import { EmoResearchService } from './emo-research.service';
import { EmoController } from './emo.controller';

/** EMO — Voice → Cards. Storage/feed/router/capture + lanes: Search, Tasks, Reminders, Story, Meetings, Research. */
@Module({
  imports: [VoiceModule, AgentModule, HermesModule, TasksModule, ContactsModule, DailyModule, FlowsModule],
  controllers: [EmoController],
  providers: [EmoCardsService, EmoRouterService, EmoCaptureService, EmoSearchService, EmoTaskService, EmoReminderService, EmoStoryService, EmoMeetingService, EmoResearchService],
  exports: [EmoCardsService, EmoRouterService],
})
export class EmoModule {}
