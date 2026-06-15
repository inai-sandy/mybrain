import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';

function meetingsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'meetings');
}

function parseArr(s: string | null): any[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

@Injectable()
export class MeetingsService {
  constructor(private readonly prisma: PrismaService) {}

  private shape(m: any) {
    return {
      id: m.id,
      title: m.title,
      agenda: m.agenda,
      durationSec: m.durationSec,
      status: m.status,
      engine: m.engine,
      hasAudio: !!m.audioPath,
      transcript: m.transcript,
      summary: m.summary,
      takeaways: parseArr(m.takeaways),
      decisions: parseArr(m.decisions),
      actionItems: parseArr(m.actionItems),
      language: m.language,
      savedToMemory: m.savedToMemory,
      shared: m.shared,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  /** Create a meeting; if an audio recording is provided, store it on the data volume. */
  async create(data: { title?: string; agenda?: string; durationSec?: number }, audio?: { buffer: Buffer; mime: string }) {
    const m = await this.prisma.meeting.create({
      data: {
        title: data.title?.trim() ? data.title.trim().slice(0, 200) : undefined,
        agenda: data.agenda?.trim() ? data.agenda.trim().slice(0, 4000) : null,
        durationSec: Number.isFinite(data.durationSec) ? Math.max(0, Math.round(Number(data.durationSec))) : 0,
      },
    });
    if (audio?.buffer?.length) {
      const dir = meetingsDir();
      await fs.mkdir(dir, { recursive: true });
      const ext = audio.mime.includes('webm') ? 'webm' : audio.mime.includes('ogg') ? 'ogg' : audio.mime.includes('mp4') || audio.mime.includes('m4a') ? 'm4a' : audio.mime.includes('wav') ? 'wav' : 'webm';
      const path = join(dir, `${m.id}.${ext}`);
      await fs.writeFile(path, audio.buffer);
      await this.prisma.meeting.update({ where: { id: m.id }, data: { audioPath: path, audioMime: audio.mime } });
    }
    return this.shape(await this.prisma.meeting.findUnique({ where: { id: m.id } }));
  }

  async list(q?: string) {
    const rows = await this.prisma.meeting.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 });
    let list = rows.map((m) => this.shape(m));
    if (q?.trim()) {
      const s = q.toLowerCase();
      list = list.filter((m) => [m.title, m.summary, m.transcript, ...(m.takeaways || [])].filter(Boolean).join(' ').toLowerCase().includes(s));
    }
    return list;
  }

  async get(id: string) {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    return m ? this.shape(m) : null;
  }

  async update(id: string, data: { title?: string; agenda?: string }) {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m) return null;
    await this.prisma.meeting.update({
      where: { id },
      data: {
        title: data.title?.trim() ? data.title.trim().slice(0, 200) : m.title,
        agenda: data.agenda !== undefined ? (data.agenda?.trim() ? data.agenda.trim().slice(0, 4000) : null) : m.agenda,
      },
    });
    return this.get(id);
  }

  async remove(id: string) {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m) return { ok: true };
    if (m.audioPath) await fs.unlink(m.audioPath).catch(() => undefined);
    await this.prisma.meeting.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  async audioFile(id: string): Promise<{ path: string; mime: string } | null> {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m?.audioPath) return null;
    return { path: m.audioPath, mime: m.audioMime || 'audio/webm' };
  }
}
