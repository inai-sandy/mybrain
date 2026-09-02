import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isOwedOn, parseSchedule, scheduleLabel } from '../tasks/schedule';
import { localDayKey, weekdayOf } from '../common/localday';
import { matchContact, matchContactsAll, contactSpellings, similarity, norm } from './person-identity';
import { TASK_OPEN, OPEN_WORK, isOpen, isDone } from '../tasks/task-status';
import { openNeedsWhere } from './needs-you';

const todayKey = () => localDayKey(new Date());

/** Contacts — people you can send WhatsApp reminders to (BEA-719). */
@Injectable()
export class ContactsService {
  private readonly log = new Logger('Contacts');

  constructor(private readonly prisma: PrismaService) {}

  private parse(s: any): string[] {
    try {
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  }
  private shape(c: any) {
    return { ...c, tags: this.parse(c.tags), aliases: this.parse(c.aliases), hasLeft: !!c.leftAt };
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

  async list(q?: string, page = 1, pageSize = 20, include: 'active' | 'left' | 'all' = 'active') {
    const where: any = q ? { OR: [{ name: { contains: q } }, { whatsappNumber: { contains: q } }, { notes: { contains: q } }] } : {};
    // Out of the way by default, never hidden: they are one filter away and clearly labelled where
    // they do appear. Someone who left is still part of the record. (BEA-1307)
    if (include === 'active') where.leftAt = null;
    else if (include === 'left') where.leftAt = { not: null };
    const ps = Math.max(1, Math.min(100, pageSize));
    const p = Math.max(1, page);
    const [rows, total] = await Promise.all([
      this.prisma.contact.findMany({ where, orderBy: { name: 'asc' }, take: ps, skip: (p - 1) * ps }),
      this.prisma.contact.count({ where }),
    ]);
    return { contacts: rows.map((r) => this.shape(r)), total, page: p, pageSize: ps };
  }

  /**
   * The contacts list as a TEAM BOARD (BEA-1219): every card answers "where do we stand with this
   * person" — open work, whether today's report is in, whether anything needs the owner's eyes,
   * and when they were last heard. Signals are batched over the visible page, so 20 cards cost a
   * handful of queries rather than a handful each.
   */
  async board(q?: string, page = 1, pageSize = 20, include: 'active' | 'left' | 'all' = 'active') {
    const base = await this.list(q, page, pageSize, include);
    const ids = base.contacts.map((c: any) => c.id);
    if (!ids.length) return base;
    const [openTasks, needs, claims, chasing, lastIns, reports, restDays] = await Promise.all([
      this.prisma.task.groupBy({ by: ['ownerContactId'], where: { ownerContactId: { in: ids }, status: TASK_OPEN }, _count: { _all: true } }).catch(() => [] as any[]),
      // The same reading the review inbox uses: needs him, not closed, work not already done. (BEA-1211, BEA-1596)
      this.prisma.teamUpdate.findMany({ where: openNeedsWhere(ids), select: { contactId: true } }).catch(() => [] as any[]),
      this.prisma.taskClaim.findMany({ where: { contactId: { in: ids }, status: 'pending', task: { status: TASK_OPEN } }, select: { contactId: true } }).catch(() => [] as any[]),
      this.prisma.reminder.groupBy({ by: ['contactId'], where: { contactId: { in: ids }, status: 'active' }, _count: { _all: true } }).catch(() => [] as any[]),
      // Exact per-contact latest — a flat row cap could let one chatty contact push a quiet one's
      // last message out of the window and make them look never-heard. (review finding)
      this.prisma.reminderMessage.groupBy({ by: ['contactId'], where: { contactId: { in: ids }, direction: 'in' }, _max: { createdAt: true } }).catch(() => [] as any[]),
      this.prisma.task.findMany({ where: { ownerContactId: { in: ids }, kind: 'recurring', status: TASK_OPEN }, select: { id: true, ownerContactId: true, scheduleDays: true } }).catch(() => [] as any[]),
      this.restDaysSafe(),
    ]);
    const statusRows = (reports as any[]).length
      ? await this.prisma.taskStatusDay.findMany({ where: { day: todayKey(), taskId: { in: (reports as any[]).map((r) => r.id) } }, select: { taskId: true, status: true } }).catch(() => [] as any[])
      : ([] as any[]);

    const count = (rows: any[], key: string) => rows.reduce<Record<string, number>>((m, r) => { m[r[key]] = (m[r[key]] || 0) + 1; return m; }, {});
    const openBy = Object.fromEntries((openTasks as any[]).map((r) => [r.ownerContactId, r._count?._all ?? 0]));
    const chaseBy = Object.fromEntries((chasing as any[]).map((r) => [r.contactId, r._count?._all ?? 0]));
    const needsBy = count([...(needs as any[]), ...(claims as any[])], 'contactId');
    const heardBy: Record<string, string> = Object.fromEntries((lastIns as any[]).map((r) => [r.contactId, r._max?.createdAt]).filter(([, v]) => v));
    const statusByTask = Object.fromEntries((statusRows as any[]).map((r) => [r.taskId, r.status]));
    const weekday = weekdayOf(todayKey());

    const shaped = base.contacts.map((c: any) => {
      // Their standing reports DUE today, folded to one signal: in / waiting / missed / none owed.
      const due = (reports as any[]).filter((r) => r.ownerContactId === c.id && isOwedOn(r.scheduleDays, weekday, restDays));
      let report: 'in' | 'waiting' | 'missed' | null = null;
      if (due.length) {
        const states = due.map((r) => statusByTask[r.id] || 'waiting');
        report = states.every((s) => s === 'received') ? 'in' : states.includes('missed') ? 'missed' : 'waiting';
      }
      return { ...c, board: { open: openBy[c.id] || 0, needsYou: needsBy[c.id] || 0, chasing: chaseBy[c.id] || 0, lastHeardAt: heardBy[c.id] || null, report } };
    });
    return { ...base, contacts: shaped };
  }

  /** Every contact as {id, name, aliases} — the small payload pickers and @mentions need. (BEA-1019) */
  async allForPicker() {
    // Someone who has left is not offered new work. Being able to pick them is how a departed
    // person ends up with a task and a chase all over again. (BEA-1307)
    const rows = await this.prisma.contact.findMany({ where: { leftAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, aliases: true } });
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

  /**
   * They have left. (BEA-1307)
   *
   * One action for what used to be impossible. Every chase stops — STOPPED, by the owner's hand, so
   * nothing resumes it automatically and the history stays. Their page goes dark. They leave the
   * pickers. Nothing is destroyed, and their open work is handed back to the owner to deal with
   * rather than being quietly closed or quietly hidden.
   *
   * The work is deliberately NOT auto-dropped: what happens to it is a decision (hand it on, or
   * drop it), and making that decision for him is how work disappears without anyone noticing.
   */
  async markLeft(id: string, note?: string) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Contact not found');
    if (c.leftAt) return { ok: true, alreadyLeft: true, ...(await this.openWorkFor(id)) };

    await this.prisma.contact.update({
      where: { id },
      data: { leftAt: new Date(), leftNote: String(note || '').trim().slice(0, 300) || null, shareEnabled: false },
    });
    // `stopped`, not `done`: the owner's own hand. `done` is what the app writes when it decides,
    // and those get offered back for resuming — which is not what "they have left" means. (BEA-1160)
    const stopped = await this.prisma.reminder
      .updateMany({ where: { contactId: id, status: { in: ['active', 'paused'] } }, data: { status: 'stopped' } })
      .catch(() => ({ count: 0 }));
    await this.prisma.reminderSend.deleteMany({ where: { reminder: { contactId: id }, status: 'queued' } }).catch(() => undefined);
    this.log.log(`${c.name} marked as left — stopped ${stopped.count} chase(s)`);
    return { ok: true, stoppedChases: stopped.count, ...(await this.openWorkFor(id)) };
  }

  /** They are back. Chases are NOT resurrected — restarting them is his call, one at a time. */
  async markBack(id: string) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Contact not found');
    await this.prisma.contact.update({ where: { id }, data: { leftAt: null, leftNote: null, shareEnabled: true } });
    this.log.log(`${c.name} is back`);
    return { ok: true };
  }

  /** Work still open with this person — what the owner has to decide about when they leave. */
  private async openWorkFor(id: string) {
    const openWork = await this.prisma.task
      .findMany({ where: { ownerContactId: id, ...OPEN_WORK }, select: { id: true, title: true, kind: true }, orderBy: { createdAt: 'asc' } })
      .catch(() => [] as any[]);
    return { openWork };
  }

  /**
   * Delete, honestly. (BEA-1307)
   *
   * The old comment here read "nothing else to clean", which was wrong in a way that mattered:
   * deleting a contact cascades away every briefing the owner wrote about them, every team update
   * they ever sent, their weekly profile and every chase — and leaves their WhatsApp messages as
   * rows nothing can reach again, because a conversation only surfaces through a reminder.
   *
   * So it now says what it will destroy, and refuses when there is real history to lose. Marking
   * them as left does everything deletion was being used for, and keeps the record.
   */
  async remove(id: string, force = false) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Contact not found');
    // Optional-chained: spec harnesses build this service with partial Prisma stubs, and a count
    // that throws would take DELETE down entirely rather than just leaving the warning vaguer.
    const count = async (fn: any): Promise<number> => (await Promise.resolve(fn).catch(() => 0)) || 0;
    // Every table that cascades. The first version counted four of them and the docstring promised
    // six — so a contact with only a weekly profile and a chase had "no history", deleted without a
    // word, and lost both. A warning that is wrong about what it protects is worse than none.
    const [briefings, updates, messages, tasks, chases, profile] = await Promise.all([
      count(this.prisma.briefing?.count?.({ where: { contactId: id } })),
      count(this.prisma.teamUpdate?.count?.({ where: { contactId: id } })),
      count(this.prisma.reminderMessage?.count?.({ where: { contactId: id } })),
      count(this.prisma.task?.count?.({ where: { ownerContactId: id } })),
      count(this.prisma.reminder?.count?.({ where: { contactId: id } })),
      count(this.prisma.contactProfile?.count?.({ where: { contactId: id } })),
    ]);
    const history = briefings + updates + messages + tasks + chases + profile;
    if (history && !force) {
      const bits = [
        briefings && `${briefings} briefing${briefings === 1 ? '' : 's'} you wrote`,
        updates && `${updates} update${updates === 1 ? '' : 's'} they sent`,
        messages && `${messages} WhatsApp message${messages === 1 ? '' : 's'}`,
        tasks && `${tasks} task${tasks === 1 ? '' : 's'}`,
        chases && `${chases} chase${chases === 1 ? '' : 's'}`,
        profile && 'their profile',
      ].filter(Boolean);
      throw new BadRequestException(
        `Deleting ${c.name} would destroy ${bits.join(', ')}. If they have left, mark them as left instead — that stops everything and keeps the record.`,
      );
    }
    await this.prisma.contact.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Contact not found');
    });
    return { ok: true, destroyed: { briefings, updates, messages, tasks, chases, profile } };
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

  /** The weekly character profile — the living row the Sunday writer maintains. (BEA-1216) */
  async profile(id: string) {
    const c = await this.prisma.contact.findUnique({ where: { id }, select: { id: true } });
    if (!c) throw new NotFoundException('Contact not found');
    const row = await this.prisma.contactProfile?.findUnique({ where: { contactId: id } }).catch(() => null);
    return { text: row?.text || null, updatedAt: row?.updatedAt || null };
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
          where: { ownerContactId: id, kind: 'recurring', status: TASK_OPEN },
          // The last days, not just today (BEA-1223): while today's is still out, the section
          // shows the most recent report's SUMMARY instead of a bare "waiting".
          select: { id: true, title: true, scheduleDays: true, statusDays: { orderBy: { day: 'desc' }, take: 8 } },
          orderBy: { createdAt: 'asc' },
        })
        .catch(() => [] as any[]),
      this.restDaysSafe(),
    ]);
    const open = tasks.filter((t) => isOpen(t));
    const oldest = open.reduce<number | null>((m, t) => {
      const d = Math.floor((Date.now() - new Date(t.createdAt).getTime()) / 86400000);
      return m === null || d > m ? d : m;
    }, null);
    const weekday = weekdayOf(todayKey());
    const today = (reports as any[]).map((t) => {
      const days: any[] = t.statusDays || [];
      const row = days.find((d) => d.day === todayKey()) || null;
      // The freshest report that actually CAME IN — what to show while today's is still out. (BEA-1223)
      const last = days.find((d) => d.status === 'received' && d.quote) || null;
      const due = isOwedOn(t.scheduleDays, weekday, restDays);
      return {
        taskId: t.id,
        title: t.title,
        schedule: parseSchedule(t.scheduleDays),
        scheduleLabel: scheduleLabel(t.scheduleDays),
        due,
        status: !due ? 'off' : row?.status || 'waiting',
        quote: row?.quote || null,
        summary: row?.summary || null, // the 1–2 line read; quote is the tap-deeper evidence (BEA-1223)
        source: row?.source || null, // 'page' = they ticked it; 'whatsapp' = they said it (BEA-1152)
        at: row?.signalAt || row?.createdAt || null,
        last: last && last.day !== todayKey() ? { day: last.day, summary: last.summary || null, quote: last.quote, source: last.source || null } : null,
      };
    });
    const dueToday = today.filter((r) => r.due);
    return {
      open: open.length,
      // Counted, never inferred by subtraction. `total - open` quietly counted DROPPED work as
      // finished the moment a third state existed — the exact lie BEA-1306 exists to stop, on the
      // page about how a person stands.
      done: tasks.filter(isDone).length,
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
    return !!t && t.ownerContactId === contactId && isOpen(t);
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
        // The last week of the ledger (BEA-1217): today answers "is it in?", the rest fills the
        // Updates tab — their own recent days, in their own words. Their data, safe to show them.
        statusDays: { orderBy: { day: 'desc' }, take: 7, select: { day: true, status: true, quote: true, source: true, createdAt: true } },
      },
    });
    const today = localDayKey();
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
      sentToday: t.kind === 'recurring' ? !!(t.statusDays || []).find((d: any) => d.day === today && d.status === 'received') : null,
      // When it is owed, in their words — so nobody has to guess. (BEA-1156)
      schedule: t.kind === 'recurring' ? scheduleLabel(t.scheduleDays) : null,
      dueToday: t.kind === 'recurring' ? isOwedOn(t.scheduleDays, weekday, rest) : null,
      // Their own last week on this report, for the Updates tab. (BEA-1217)
      history: t.kind === 'recurring'
        ? (t.statusDays || []).map((d: any) => ({ day: d.day, status: d.status, quote: d.quote || null, source: d.source || null }))
        : null,
    });

    const open = rows.filter((t) => isOpen(t)).map(shape);
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
