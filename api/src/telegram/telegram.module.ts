import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { DailyModule } from '../daily/daily.module';
import { ChatModule } from '../chat/chat.module';
import { ItemsModule } from '../items/items.module';
import { VoiceModule } from '../voice/voice.module';
import { AgentModule } from '../agent/agent.module';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [TasksModule, DailyModule, ChatModule, ItemsModule, VoiceModule, AgentModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
