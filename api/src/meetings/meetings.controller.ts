import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
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

  // --- transcription engine (static routes MUST precede :id) ---
  @Get('engines')
  async engines() {
    return this.meetings.engineOptions();
  }

  @Put('engine')
  async setEngine(@Body() body: { engine?: string }) {
    return this.meetings.setEngine(body?.engine || '');
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

  /** Opt-in transcription + AI summary for one meeting, with a chosen engine. */
  @Post(':id/transcribe')
  async transcribe(@Param('id') id: string, @Body() body: { engine?: string }) {
    const r = await this.meetings.transcribe(id, body?.engine);
    if (!r) throw new BadRequestException('Meeting not found');
    if (r.error === 'no-audio') throw new BadRequestException('This meeting has no recording to transcribe.');
    if (r.error === 'transcribe-failed') throw new BadRequestException('Transcription failed — check the engine’s API key in Settings → Integrations, or try another engine.');
    return r;
  }

  @Post(':id/share')
  async share(@Param('id') id: string, @Body() body: { shared?: boolean }) {
    const r = await this.meetings.setShared(id, !!body?.shared);
    if (!r) throw new BadRequestException('Meeting not found');
    return r;
  }

  @Post(':id/save-memory')
  async saveMemory(@Param('id') id: string) {
    const r = await this.meetings.saveToMemory(id);
    if (!r) throw new BadRequestException('Meeting not found');
    return r;
  }

  /** Stream the stored recording for playback. Honors HTTP Range so the <audio> element
   *  (Safari requires 206 Partial Content) can play and seek. */
  @Get(':id/audio')
  async audio(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const f = await this.meetings.audioFile(id);
    if (!f) throw new BadRequestException('No audio for this meeting');
    let size = 0;
    try {
      size = (await stat(f.path)).size;
    } catch {
      throw new BadRequestException('Recording file missing');
    }
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    const range = req.headers.range;
    const m = range && /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (Number.isNaN(start) || start > end || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      return createReadStream(f.path, { start, end }).pipe(res);
    }
    res.setHeader('Content-Length', size);
    return createReadStream(f.path).pipe(res);
  }
}
