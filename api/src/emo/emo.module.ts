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
import { EmoAskService } from './emo-ask.service';
import { ExploreModule } from '../explore/explore.module';
import { MemoryModule } from '../memory/memory.module';
import { EmoController } from './emo.controller';

/** EMO — Voice → Cards. Storage/feed/router/capture + lanes: Search, Tasks, Reminders, Story, Meetings, Research. */
@Module({
  imports: [VoiceModule, AgentModule, HermesModule, TasksModule, ContactsModule, DailyModule, FlowsModule, ExploreModule, MemoryModule],
  controllers: [EmoController],
  providers: [EmoCardsService, EmoRouterService, EmoCaptureService, EmoSearchService, EmoTaskService, EmoReminderService, EmoStoryService, EmoMeetingService, EmoResearchService, EmoAskService],
  exports: [EmoCardsService, EmoRouterService],
})
export class EmoModule {}
