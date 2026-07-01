import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Contacts — people you can send WhatsApp reminders to (BEA-719). */
@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  private parse(s: any): string[] {
    try {
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  }
  private shape(c: any) {
    return { ...c, tags: this.parse(c.tags) };
  }
  /** Keep digits + country code only; blank → null. */
  private normNumber(n?: string | null): string | null {
    if (!n) return null;
    const d = String(n).replace(/[^\d]/g, '');
    return d ? d : null;
  }

  async list(q?: string, page = 1, pageSize = 20) {
    const where: any = q ? { OR: [{ name: { contains: q } }, { whatsappNumber: { contains: q } }, { notes: { contains: q } }] } : {};
    const ps = Math.max(1, Math.min(100, pageSize));
    const p = Math.max(1, page);
    const [rows, total] = await Promise.all([
      this.prisma.contact.findMany({ where, orderBy: { name: 'asc' }, take: ps, skip: (p - 1) * ps }),
      this.prisma.contact.count({ where }),
    ]);
    return { contacts: rows.map((r) => this.shape(r)), total, page: p, pageSize: ps };
  }

  async get(id: string) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Contact not found');
    return this.shape(c);
  }

  async create(input: { name?: string; whatsappNumber?: string; notes?: string; tags?: string[] }) {
    const name = (input.name || '').trim();
    if (!name) throw new BadRequestException('A name is required');
    const c = await this.prisma.contact.create({
      data: {
        name: name.slice(0, 120),
        whatsappNumber: this.normNumber(input.whatsappNumber),
        notes: input.notes?.trim() || null,
        tags: JSON.stringify(Array.isArray(input.tags) ? input.tags : []),
      },
    });
    return this.shape(c);
  }

  async update(id: string, patch: { name?: string; whatsappNumber?: string; notes?: string; tags?: string[] }) {
    await this.get(id);
    const data: any = {};
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n) throw new BadRequestException('A name is required');
      data.name = n.slice(0, 120);
    }
    if (patch.whatsappNumber !== undefined) data.whatsappNumber = this.normNumber(patch.whatsappNumber);
    if (patch.notes !== undefined) data.notes = patch.notes?.trim() || null;
    if (patch.tags !== undefined) data.tags = JSON.stringify(Array.isArray(patch.tags) ? patch.tags : []);
    const c = await this.prisma.contact.update({ where: { id }, data });
    return this.shape(c);
  }

  async remove(id: string) {
    await this.prisma.contact.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Contact not found');
    });
    return { ok: true };
  }

  /** Resolve a task's `party` name to a contact, case-insensitive (used by reminders, BEA-721). */
  async findByName(name?: string | null) {
    if (!name?.trim()) return null;
    const lc = name.trim().toLowerCase();
    const all = await this.prisma.contact.findMany();
    const hit = all.find((c) => (c.name || '').toLowerCase() === lc);
    return hit ? this.shape(hit) : null;
  }
}
