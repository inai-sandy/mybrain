import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { MeetingsService } from './meetings.service';

@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  /** Create a meeting from a recording (multipart: audio + title/agenda/durationSec). */
  @Post()
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 300 * 1024 * 1024 } }))
  async create(@UploadedFile() file: any, @Body() body: { title?: string; agenda?: string; durationSec?: string }) {
    const audio = file?.buffer ? { buffer: file.buffer as Buffer, mime: file.mimetype || 'audio/webm' } : undefined;
    return this.meetings.create({ title: body?.title, agenda: body?.agenda, durationSec: body?.durationSec ? Number(body.durationSec) : 0 }, audio);
  }

  @Get()
  async list(@Query('q') q?: string) {
    return { meetings: await this.meetings.list(q) };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const m = await this.meetings.get(id);
    if (!m) throw new BadRequestException('Meeting not found');
    return m;
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: { title?: string; agenda?: string }) {
    const m = await this.meetings.update(id, body || {});
    if (!m) throw new BadRequestException('Meeting not found');
    return m;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.meetings.remove(id);
  }

  /** Stream the stored recording for playback. */
  @Get(':id/audio')
  async audio(@Param('id') id: string, @Res() res: Response) {
    const f = await this.meetings.audioFile(id);
    if (!f) throw new BadRequestException('No audio for this meeting');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    createReadStream(f.path).pipe(res);
  }
}
