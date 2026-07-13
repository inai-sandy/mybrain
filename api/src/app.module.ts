import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
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
import { VaultModule } from './vault/vault.module';
import { MindModule } from './mind/mind.module';
import { DocumentsModule } from './documents/documents.module';
import { AgentModule } from './agent/agent.module';
import { HermesModule } from './hermes/hermes.module';
import { PublicMcpModule } from './public-mcp/public-mcp.module';
import { OAuthModule } from './oauth/oauth.module';
import { FlowsModule } from './flows/flows.module';
import { ContactsModule } from './contacts/contacts.module';
import { EmoModule } from './emo/emo.module';
import { RecordingsModule } from './recordings/recordings.module';

@Module({
  imports: [
    // Rate-limit config (BEA-829). NOT applied globally — a global guard would throttle the app's own
    // polling; only the sensitive endpoints opt in via @UseGuards(ThrottlerGuard)+@Throttle.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule, AuthModule, ConnectorModule, LlmModule, PromptsModule, MemoryModule, ItemsModule, BookmarksModule, IdeasModule, SkillsModule, TasksModule, DailyModule, MentorModule, VoiceModule, NotesModule, UsageModule, TelegramModule, ChatModule, HomeModule, CodexModule, MeetingsModule, GoogleModule, ExploreModule, GeminiModule, AccountabilityModule, ConnectionsModule, VaultModule, MindModule, DocumentsModule, AgentModule, HermesModule, PublicMcpModule, OAuthModule, FlowsModule, ContactsModule, EmoModule, RecordingsModule],
  controllers: [HealthController],
})
export class AppModule {}
