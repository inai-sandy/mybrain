import { Module } from '@nestjs/common';
import { MeetingsService } from './meetings.service';
import { MeetingsController } from './meetings.controller';
import { MeetingShareController } from './meeting-share.controller';
import { VoiceModule } from '../voice/voice.module';
import { LlmModule } from '../llm/llm.module';
import { PromptsModule } from '../prompts/prompts.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [VoiceModule, LlmModule, PromptsModule, MemoryModule],
  providers: [MeetingsService],
  controllers: [MeetingsController, MeetingShareController],
  exports: [MeetingsService],
})
export class MeetingsModule {}
