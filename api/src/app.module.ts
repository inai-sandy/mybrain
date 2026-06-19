import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ConnectorModule } from './connectors/connector.module';
import { MemoryModule } from './memory/memory.module';
import { ItemsModule } from './items/items.module';
import { BookmarksModule } from './bookmarks/bookmarks.module';
import { IdeasModule } from './ideas/ideas.module';
import { SkillsModule } from './skills/skills.module';
import { TasksModule } from './tasks/tasks.module';
import { DailyModule } from './daily/daily.module';
import { MentorModule } from './mentor/mentor.module';
import { VoiceModule } from './voice/voice.module';
import { NotesModule } from './notes/notes.module';
import { UsageModule } from './usage/usage.module';
import { TelegramModule } from './telegram/telegram.module';
import { ChatModule } from './chat/chat.module';
import { HomeModule } from './home/home.module';
import { PromptsModule } from './prompts/prompts.module';
import { LlmModule } from './llm/llm.module';
import { CodexModule } from './codex/codex.module';
import { MeetingsModule } from './meetings/meetings.module';
import { GoogleModule } from './google/google.module';
import { ExploreModule } from './explore/explore.module';
import { GeminiModule } from './gemini/gemini.module';
import { AccountabilityModule } from './accountability/accountability.module';
import { ConnectionsModule } from './connections/connections.module';

@Module({
  imports: [PrismaModule, AuthModule, ConnectorModule, LlmModule, PromptsModule, MemoryModule, ItemsModule, BookmarksModule, IdeasModule, SkillsModule, TasksModule, DailyModule, MentorModule, VoiceModule, NotesModule, UsageModule, TelegramModule, ChatModule, HomeModule, CodexModule, MeetingsModule, GoogleModule, ExploreModule, GeminiModule, AccountabilityModule, ConnectionsModule],
  controllers: [HealthController],
})
export class AppModule {}
