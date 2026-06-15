import { Module } from '@nestjs/common';
import { MeetingsService } from './meetings.service';
import { MeetingsController } from './meetings.controller';
import { VoiceModule } from '../voice/voice.module';
import { LlmModule } from '../llm/llm.module';
import { PromptsModule } from '../prompts/prompts.module';

@Module({
  imports: [VoiceModule, LlmModule, PromptsModule],
  providers: [MeetingsService],
  controllers: [MeetingsController],
  exports: [MeetingsService],
})
export class MeetingsModule {}
