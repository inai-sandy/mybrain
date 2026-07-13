import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { RecordingsService } from './recordings.service';

/** Recordings (BEA-973). Device routes authenticate via X-Device-Token (global guard);
 *  the rest are the owner's session like every other page. */
@Controller('recordings')
export class RecordingsController {
  constructor(private readonly svc: RecordingsService) {}

  // ---- device (EMO Cam) ----
  @Post('device/start')
  start(@Body() body: { startedAt?: number }) {
    return this.svc.start(body?.startedAt);
  }

  @Post('device/:id/chunk')
  async chunk(@Req() req: Request, @Param('id') id: string, @Query('seq') seq?: string) {
    const MAX = 20 * 1024 * 1024; // a 10-min opus chunk is ~1.8MB; hard stop way above it
    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      req.on('data', (c: Buffer) => {
        total += c.length;
        if (total > MAX) {
          reject(new BadRequestException('Chunk too large'));
          try { req.destroy(); } catch { /* closing */ }
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve());
      req.on('error', (e) => reject(e));
    });
    return this.svc.addChunk(id, Number(seq) || 0, Buffer.concat(chunks));
  }

  @Post('device/:id/mark')
  mark(@Param('id') id: string, @Body() body: { atSeconds?: number; window?: number }) {
    return this.svc.addMark(id, Number(body?.atSeconds) || 0, Number(body?.window) || 120, 'tap');
  }

  @Post('device/:id/end')
  end(@Param('id') id: string) {
    return this.svc.end(id);
  }

  // ---- web ----
  @Get()
  list(@Query('q') q?: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    return this.svc.list({ q, take: Number(take) || undefined, skip: Number(skip) || undefined });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Get(':id/chunk/:seq/audio')
  async audio(@Param('id') id: string, @Param('seq') seq: string, @Res() res: Response) {
    const wav = await this.svc.chunkWav(id, Number(seq) || 0);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(wav);
  }

  @Post(':id/transcribe')
  transcribe(@Param('id') id: string, @Body() body: { fromSec?: number; toSec?: number }) {
    return this.svc.transcribeRange(id, Number(body?.fromSec) || 0, Number(body?.toSec) || 0);
  }

  @Post('marks/:id/promote')
  promote(@Param('id') id: string) {
    return this.svc.promote(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
