import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isOwedOn, parseSchedule, scheduleLabel } from '../tasks/schedule';
import { localDayKey, weekdayOf } from '../common/localday';
import { matchContact, matchContactsAll, contactSpellings, similarity, norm } from './person-identity';

const todayKey = () => localDayKey(new Date());

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
    return { ...c, tags: this.parse(c.tags), aliases: this.parse(c.aliases) };
  }
  private cleanNames(list?: string[]): string[] {
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of list) {
      const t = String(s || '').trim().slice(0, 80);
      if (t && !seen.has(norm(t))) { seen.add(norm(t)); out.push(t); }
    }
    return out;
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

  /** Every contact as {id, name, aliases} — the small payload pickers and @mentions need. (BEA-1019) */
  async allForPicker() {
    const rows = await this.prisma.contact.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, aliases: true } });
    return {
      contacts: rows.map((r) => {
        let aliases: string[] = [];
        try { const a = JSON.parse((r as any).aliases || '[]'); if (Array.isArray(a)) aliases = a; } catch { /* a corrupt row must not break the picker */ }
        return { id: r.id, name: r.name, aliases };
      }),
    };
  }

  async get(id: string) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Contact not found');
    return this.shape(c);
  }

  async create(input: { name?: string; whatsappNumber?: string; notes?: string; tags?: string[]; aliases?: string[] }) {
    const name = (input.name || '').trim();
    if (!name) throw new BadRequestException('A name is required');
    const c = await this.prisma.contact.create({
      data: {
        name: name.slice(0, 120),
        whatsappNumber: this.normNumber(input.whatsappNumber),
        notes: input.notes?.trim() || null,
        tags: JSON.stringify(Array.isArray(input.tags) ? input.tags : []),
        aliases: JSON.stringify(this.cleanNames(input.aliases).filter((a) => norm(a) !== norm(name))),
      },
    });
    return this.shape(c);
  }

  async update(id: string, patch: { name?: string; whatsappNumber?: string; notes?: string; tags?: string[]; aliases?: string[] }) {
    const cur = await this.get(id);
    const data: any = {};
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n) throw new BadRequestException('A name is required');
      data.name = n.slice(0, 120);
    }
    if (patch.whatsappNumber !== undefined) data.whatsappNumber = this.normNumber(patch.whatsappNumber);
    if (patch.notes !== undefined) data.notes = patch.notes?.trim() || null;
    if (patch.tags !== undefined) data.tags = JSON.stringify(Array.isArray(patch.tags) ? patch.tags : []);
    if (patch.aliases !== undefined) {
      const name = norm(data.name || cur.name);
      data.aliases = JSON.stringify(this.cleanNames(patch.aliases).filter((a) => norm(a) !== name));
    }
    const c = await this.prisma.contact.update({ where: { id }, data });
    // Renaming a person carries their work with them: the tasks they own keep showing the current
    // name, not the one typed months ago. The link is what matters — this just keeps the stored
    // display text honest for anything that still reads it. (BEA-1019)
    if (data.name && data.name !== cur.name) {
      await this.prisma.task
        .updateMany({ where: { ownerContactId: id }, data: { party: String(data.name).slice(0, 80) } })
        .catch(() => undefined);
    }
    return this.shape(c);
  }

  /** Append one alias (used by "add as alias" suggestions). */
  async addAlias(id: string, alias: string) {
    const cur = await this.get(id);
    const next = this.cleanNames([...(cur.aliases || []), alias]).filter((a) => norm(a) !== norm(cur.name));
    const c = await this.prisma.contact.update({ where: { id }, data: { aliases: JSON.stringify(next) } });
    return this.shape(c);
  }

  /** Suggest close story/task names that likely mean this same person (fuzzy, ≥0.55). (BEA-763) */
  async aliasSuggestions(id: string) {
    const contact = await this.get(id);
    const all = (await this.prisma.contact.findMany()).map((c) => this.shape(c));
    const others = all.filter((c) => c.id !== contact.id);
    const mine = contactSpellings(contact).map(norm);
    // Candidate names from stories + task parties, with a count.
    const counts = new Map<string, number>();
    for (const m of await this.prisma.personMention.findMany({ select: { name: true } })) counts.set(m.name, (counts.get(m.name) || 0) + 1);
    for (const t of await this.prisma.task.findMany({ where: { party: { not: null } }, select: { party: true } })) {
      const p = (t.party || '').trim();
      if (p) counts.set(p, (counts.get(p) || 0) + 1);
    }
    const suggestions = [...counts.entries()]
      .filter(([nm]) => nm && !mine.includes(norm(nm)) && !matchContact(others, nm)) // not already me, not someone else
      .map(([nm, count]) => ({ name: nm, count, score: Math.max(...contactSpellings(contact).map((s) => similarity(s, nm))) }))
      .filter((s) => s.score >= 0.55)
      .sort((a, b) => b.score - a.score || b.count - a.count)
      .slice(0, 6);
    return { suggestions };
  }

  async remove(id: string) {
    await this.prisma.contact.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Contact not found');
    });
    // Their profile lives in a Setting keyed by id (BEA-1215/1216) — no FK to cascade it.
    // Optional-chained: spec harnesses stub a partial Prisma.
    await this.prisma.setting?.delete({ where: { key: `contact.profile.${id}` } }).catch(() => undefined);
    return { ok: true };
  }

  /** Resolve a name to a contact by its name OR any alias (used by reminders + people links). (BEA-763) */
  async findByName(name?: string | null) {
    if (!name?.trim()) return null;
    const all = (await this.prisma.contact.findMany()).map((c) => this.shape(c));
    return matchContact(all, name) || null;
  }

  /** EVERY contact matching a name/alias — lets callers gate on ambiguity ("which Dharmendra?"). (BEA-875) */
  async findAllByName(name?: string | null) {
    if (!name?.trim()) return [];
    const all = (await this.prisma.contact.findMany()).map((c) => this.shape(c));
    return matchContactsAll(all, name);
  }

  // ---- Their own page: one short link per contact (BEA-1027) ---------------------------------

  /** Unambiguous alphabet — no 0/O/1/l/I, so the link survives being read out loud. */
  private static readonly TAIL = 'abcdefghjkmnpqrstuvwxyz23456789';

  private slugName(name: string): string {
    const base = String(name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    return base || 'person';
  }

  private randomTail(n = 4): string {
    const a = ContactsService.TAIL;
    let out = '';
    const bytes = randomBytes(n);
    for (let i = 0; i < n; i++) out += a[bytes[i] % a.length];
    return out;
  }

  /**
   * Their permanent link. A readable name PLUS a random tail: readable alone would be guessable
   * (type someone else's name and you would read their work), and random alone would be
   * meaningless when read out on a call. (BEA-1027)
   */
  private async freshSlug(name: string): Promise<string> {
    for (let i = 0; i < 12; i++) {
      const slug = `${this.slugName(name)}-${this.randomTail()}`;
      const clash = await this.prisma.contact.findUnique({ where: { shareSlug: slug }, select: { id: true } });
      if (!clash) return slug;
    }
    return `${this.slugName(name)}-${this.randomTail(8)}`; // effectively impossible to reach
  }

  /** The contact's link, creating it the first time it is asked for. */
  async share(id: string) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Contact not found');
    let slug = c.shareSlug;
    if (!slug) {
      slug = await this.freshSlug(c.name);
      await this.prisma.contact.update({ where: { id }, data: { shareSlug: slug } });
    }
    return { slug, path: `/t/${slug}`, enabled: c.shareEnabled !== false };
  }

  /** Issue a NEW link and kill the old one — for when a link has gone somewhere it shouldn't. */
  async rotateShare(id: string) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Contact not found');
    const slug = await this.freshSlug(c.name);
    await this.prisma.contact.update({ where: { id }, data: { shareSlug: slug, shareEnabled: true } });
    return { slug, path: `/t/${slug}`, enabled: true };
  }

  /** Turn the page off (or back on) without losing the link. */
  async setShareEnabled(id: string, enabled: boolean) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Contact not found');
    await this.prisma.contact.update({ where: { id }, data: { shareEnabled: !!enabled } });
    return { enabled: !!enabled };
  }

  /**
   * The weekly character profile (BEA-1216). Stored in a Setting per contact until the weekly
   * writer lands — the endpoint exists first (BEA-1215) so the page's accordion answers cleanly.
   */
  async profile(id: string) {
    const c = await this.prisma.contact.findUnique({ where: { id }, select: { id: true } });
    if (!c) throw new NotFoundException('Contact not found');
    const row = await this.prisma.setting.findUnique({ where: { key: `contact.profile.${id}` } }).catch(() => null);
    if (!row?.value) return { text: null, updatedAt: null };
    try {
      const v = JSON.parse(row.value);
      return { text: typeof v?.text === 'string' ? v.text : null, updatedAt: v?.updatedAt || null };
    } catch {
      return { text: null, updatedAt: null };
    }
  }

  /**
   * How this person stands right now: what's open, what's waiting on the owner, whether anything
   * is being chased, and when they were last heard from. One glance at the top of their page.
   * (BEA-1037)
   */
  async state(id: string) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Contact not found');
    const [tasks, claims, chasing, lastIn, reports, restDays] = await Promise.all([
      this.prisma.task.findMany({ where: { ownerContactId: id }, select: { status: true, createdAt: true } }),
      this.prisma.taskClaim.count({ where: { contactId: id, status: 'pending' } }),
      this.prisma.reminder.count({ where: { contactId: id, status: 'active' } }),
      this.prisma.reminderMessage.findFirst({ where: { contactId: id, direction: 'in' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      // Their standing reports, so "did today's come in?" is answered HERE rather than on a
      // different screen. (BEA-1149)
      this.prisma.task
        .findMany({
          where: { ownerContactId: id, kind: 'recurring', status: { not: 'done' } },
          select: { id: true, title: true, scheduleDays: true, statusDays: { where: { day: todayKey() }, take: 1 } },
          orderBy: { createdAt: 'asc' },
        })
        .catch(() => [] as any[]),
      this.restDaysSafe(),
    ]);
    const open = tasks.filter((t) => t.status !== 'done');
    const oldest = open.reduce<number | null>((m, t) => {
      const d = Math.floor((Date.now() - new Date(t.createdAt).getTime()) / 86400000);
      return m === null || d > m ? d : m;
    }, null);
    const weekday = weekdayOf(todayKey());
    const today = (reports as any[]).map((t) => {
      const row = t.statusDays?.[0] || null;
      const due = isOwedOn(t.scheduleDays, weekday, restDays);
      return {
        taskId: t.id,
        title: t.title,
        schedule: parseSchedule(t.scheduleDays),
        scheduleLabel: scheduleLabel(t.scheduleDays),
        due,
        status: !due ? 'off' : row?.status || 'waiting',
        quote: row?.quote || null,
        source: row?.source || null, // 'page' = they ticked it; 'whatsapp' = they said it (BEA-1152)
        at: row?.signalAt || row?.createdAt || null,
      };
    });
    const dueToday = today.filter((r) => r.due);
    return {
      open: open.length,
      done: tasks.length - open.length,
      awaitingYou: claims,
      chasing,
      oldestOpenDays: oldest,
      lastHeardAt: lastIn?.createdAt || null,
      today: {
        day: todayKey(),
        weekday,
        due: dueToday,
        notDue: today.filter((r) => !r.due),
        counts: { due: dueToday.length, received: dueToday.filter((r) => r.status === 'received').length },
      },
    };
  }

  /** Rest days, defensively — a broken setting must never hide a report. */
  private async restDaysSafe(): Promise<string[]> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: 'recurring.restDays' } });
      if (!row?.value) return ['Sun'];
      const a = JSON.parse(row.value);
      return Array.isArray(a) ? a.filter((d: unknown) => typeof d === 'string') : ['Sun'];
    } catch {
      return ['Sun'];
    }
  }

  /** Resolve a share link to its contact, refusing a bad or turned-off one. (BEA-1028) */
  async contactForShare(slug: string) {
    const c = await this.prisma.contact.findUnique({ where: { shareSlug: String(slug || '') } });
    if (!c || c.shareEnabled === false) throw new NotFoundException('This link is not valid');
    return c;
  }

  /** Does this task actually belong to this contact? Nobody may tick someone else's work. */
  async ownsTask(contactId: string, taskId: string): Promise<boolean> {
    const t = await this.prisma.task.findUnique({ where: { id: String(taskId || '') }, select: { ownerContactId: true, status: true } });
    return !!t && t.ownerContactId === contactId && t.status !== 'done';
  }

  /**
   * What the contact sees. PUBLIC — no login — so it returns only what they already know: their
   * own work. Never the owner's private notes, never anyone else's tasks. (BEA-1027)
   */
  /** assignment | recurring — so a caller can tell a one-off deliverable from a daily report. */
  async taskKind(taskId: string): Promise<string> {
    const t = await this.prisma.task.findUnique({ where: { id: taskId }, select: { kind: true } }).catch(() => null);
    return t?.kind || 'assignment';
  }

  async publicBoard(slug: string) {
    const c = await this.prisma.contact.findUnique({ where: { shareSlug: String(slug || '') } });
    if (!c) throw new NotFoundException('This link is not valid');
    if (c.shareEnabled === false) return { off: true, name: c.name };

    const rest = await this.restDaysSafe();
    const weekday = weekdayOf(localDayKey());
    const rows = await this.prisma.task.findMany({
      where: { ownerContactId: c.id },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 300,
      select: {
        id: true, title: true, note: true, status: true, dueDate: true, createdAt: true, completedAt: true, promisedFor: true, kind: true, scheduleDays: true,
        claims: { where: { status: 'pending' }, take: 1, select: { id: true, quote: true, createdAt: true } },
        // For a daily report the only question is whether TODAY's is in — "tick it off" makes no
        // sense for something owed again tomorrow. (BEA-1118)
        statusDays: { where: { day: localDayKey(), status: 'received' }, take: 1, select: { createdAt: true } },
      },
    });
    const shape = (t: any) => ({
      id: t.id,
      title: t.title,
      note: t.note,
      kind: t.kind || 'assignment',
      givenAt: t.createdAt,
      dueDate: t.dueDate,
      promisedFor: t.promisedFor,
      completedAt: t.completedAt,
      claimed: t.claims?.[0] ? { at: t.claims[0].createdAt, note: t.claims[0].quote } : null,
      // Daily items: has today's update already been sent?
      sentToday: t.kind === 'recurring' ? !!t.statusDays?.[0] : null,
      // When it is owed, in their words — so nobody has to guess. (BEA-1156)
      schedule: t.kind === 'recurring' ? scheduleLabel(t.scheduleDays) : null,
      dueToday: t.kind === 'recurring' ? isOwedOn(t.scheduleDays, weekday, rest) : null,
    });

    const open = rows.filter((t) => t.status !== 'done').map(shape);
    // A standing report is only asked for on ITS OWN days. BEA-1147 fixed this for the owner's board
    // and the chase, and never reached the page his team actually looks at — on a Tuesday Rakesh was
    // being asked for Friday's, Wednesday's AND Monday's updates, all at once. (BEA-1156)
    return {
      off: false,
      name: c.name,
      // What they owe right now: their assignments, plus only the reports due today.
      open: open.filter((t) => t.kind !== 'recurring' || t.dueToday),
      // Their standing reports, so they can see what is coming without being asked for it today.
      reports: open.filter((t) => t.kind === 'recurring'),
      done: rows.filter((t) => t.status === 'done').map(shape),
    };
  }
}
