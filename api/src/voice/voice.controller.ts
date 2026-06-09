import { BadRequestException, Body, Controller, Get, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VoiceService } from './voice.service';

@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /** Record-then-transcribe: the in-app mic posts the recorded audio here. */
  @Post('transcribe')
  @UseInterceptors(FileInterceptor('audio'))
  async transcribe(@UploadedFile() file: any) {
    if (!file?.buffer?.length) throw new BadRequestException('No audio received');
    const text = await this.voice.transcribe(file.buffer, file.originalname || 'audio.webm', file.mimetype || 'audio/webm');
    return { text };
  }

  @Get('config')
  async config() {
    return this.voice.config();
  }

  @Put('engine')
  async setEngine(@Body() body: { engine?: string }) {
    if (!body?.engine) throw new BadRequestException('Pick an engine');
    return this.voice.setEngine(body.engine);
  }

  @Put('cleanup')
  async setCleanup(@Body() body: { cleanup?: boolean }) {
    return this.voice.setCleanup(body?.cleanup !== false);
  }

  @Put('language')
  async setLanguage(@Body() body: { language?: string }) {
    return this.voice.setLanguage(body?.language || '');
  }
}
