import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TASK_SETTING_KEYS, parseChaseTimes } from '../tasks/task-settings';
import { LlmService } from '../llm/llm.service';
import { TasksService } from '../tasks/tasks.service';
import { RemindersService } from '../contacts/reminders.service';
import { DailyService } from './daily.service';
import { PromptsService } from '../prompts/prompts.service';
import { looseJsonParse } from '../common/llm-json';
import { matchContact } from '../contacts/person-identity';
import { cacheDecision, storyFingerprint } from './mine-cache';

/** One mined section item, ready for the owner's tick. Nothing here is saved until applied. */
export type MinedDelegation = { contactName: string; contactId: string | null; title: string; chase: boolean };
export type MinedReminder = { title: string; date: string | null };
export type MinedPromise = { to: string; contactId: string | null; what: string; date: string | null };
export type MinedEmotions = { lifted: string[]; drained: string[]; energy: number | null; worry: number | null; feeling: string | null };
export type MinedEvent = { at: string | null; title: string };
export type MinedPayload = {
  day: string;
  hasStory: boolean;
  failed?: boolean; // the model reply was unusable — the UI must offer a retry, never claim "tidy day" (BEA-1052)
  /** The reply was cut off and we salvaged what was complete — part of his day is genuinely
   *  missing, and the card must say so rather than look tidy. (BEA-1163) */
  partial?: boolean;
  /** One of the two reads came back empty. 'work' = tasks are missing, 'day' = feelings and the
   *  timeline are. Half a day is worth showing; pretending it is whole is not. (BEA-1166) */
  missing?: 'work' | 'day' | null;
  /** Served from the stored reading — no call was made, and nothing was charged. (BEA-1164) */
  cached?: boolean;
  /** The story was edited after this reading was made. Shown, never silently re-run. (BEA-1164) */
  stale?: boolean;
  done: { title: string; category: string | null }[];
  todos: { title: string; category: string | null; note: string | null; priority: string }[];
  delegations: MinedDelegation[];
  myReminders: MinedReminder[];
  promises: MinedPromise[];
  emotions: MinedEmotions | null;
  events: MinedEvent[];
  lessons: string[];
};

/**
 * Deep story mining (BEA-1051) — the owner's words: "this is the soul of the entire application."
 * ONE careful read of the day's story proposes everything hidden in it — finished work, to-dos,
 * work he handed to his team, reminders and promises, how the day FELT, what he actually did hour
 * by hour, and what the day taught him. Everything is a PROPOSAL: nothing is created until he
 * ticks it in the Close-day wizard, and a person is never guessed — exact contact match or unlinked.
 */
@Injectable()
export class StoryMiningService {
  private readonly log = new Logger('StoryMining');

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: TasksService,
    private readonly reminders: RemindersService,
    private readonly daily: DailyService,
    private readonly prompts: PromptsService,
  ) {}

  private empty(day: string, hasStory = false): MinedPayload {
    return { day, hasStory, done: [], todos: [], delegations: [], myReminders: [], promises: [], emotions: null, events: [], lessons: [] };
  }

  /**
   * One-time backfill of the VISIBLE parts only — emotions + the life-timeline — for days already
   * told before the wizard existed, so the Activity "How the day felt" card isn't empty. Reads his
   * real stories; writes nothing but emotions and DayEvents (no tasks, no chases). (BEA-1058)
   */
  async backfillFeelings(days = 7): Promise<{ filled: number; scanned: number }> {
    const rows = await this.prisma.story.findMany({
      where: { emotions: null },
      orderBy: { day: 'desc' },
      take: Math.max(1, Math.min(31, days)),
    });
    let filled = 0;
    for (const s of rows) {
      if ((s.rawText || '').trim().length < 30) continue;
      const mined = await this.mine(s.day).catch(() => null);
      if (!mined || mined.failed || (!mined.emotions && !mined.events.length)) continue;
      await this.apply(s.day, { emotions: mined.emotions, events: mined.events }).catch(() => undefined);
      filled++;
    }
    return { filled, scanned: rows.length };
  }

  /** All contacts shaped for the exact-match rule. */
  private async contacts(): Promise<{ id: string; name: string; aliases: string[] }[]> {
    const rows = await this.prisma.contact.findMany({ select: { id: true, name: true, aliases: true } });
    return rows.map((c) => {
      let aliases: string[] = [];
      try { const a = JSON.parse((c as any).aliases || '[]'); if (Array.isArray(a)) aliases = a; } catch { /* ignore */ }
      return { id: c.id, name: c.name, aliases };
    });
  }

  /** Mine one day's story. Read-only — returns proposals for the wizard, creates NOTHING. */
  /**
   * Two opens of the same day must not both pay for the same read. (BEA-1164)
   *
   * The cache below only helps once a reading has been WRITTEN — two tabs starting within the same
   * ~30 seconds would both sail past it and both spend a call, which is a smaller version of the
   * very bug this fixes. Callers share one in-flight read per day instead.
   */
  private inFlight = new Map<string, Promise<MinedPayload>>();

  async mine(day: string, opts: { force?: boolean } = {}): Promise<MinedPayload> {
    const key = `${day}:${opts.force ? 'force' : 'cached'}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.mineOnce(day, opts).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /**
   * One half of the read, with its own retry. (BEA-1166)
   *
   * The ceiling used to be 2500 and on 28 July his story blew past it three times in a row — each
   * reply cut off mid-JSON and thrown away whole. An unused ceiling costs nothing (only generated
   * tokens are billed), so it sits well clear of a long day. Split in two, each half needs far less
   * of it than the single call did. (BEA-1163)
   *
   * The retry must ASK FOR SOMETHING DIFFERENT. It used to resend the identical prompt at the
   * identical ceiling and so failed identically — which is why every failure in his log is a pair
   * rather than a recovery.
   */
  private async readHalf(
    day: string,
    half: 'work' | 'day',
    promptKey: 'daily.storyMineWork' | 'daily.storyMineDay',
    context: string,
    model: any,
  ): Promise<{ json: any; truncated: boolean }> {
    const CEILING = 6000;
    const tmpl = await this.prompts.get(promptKey);
    const prompt = `${tmpl.replace(/\{\{day\}\}/g, day)}\n\n${context}`;
    const shorter =
      half === 'work'
        ? 'IMPORTANT: keep it SHORT. Only the clearest finished work, to-dos and delegations. Fewer items, no long snippets.'
        : 'IMPORTANT: keep it SHORT. Only how the day felt and the main few events. Skip the lessons.';

    let json: any = null;
    let truncated = false;
    for (let attempt = 0; attempt < 2 && !json; attempt++) {
      const ask = attempt === 0 ? prompt : `${prompt}\n\n${shorter}`;
      const raw = (await this.llm.completeWith(model, ask, CEILING, `story-mine-${half}`).catch(() => null)) || '';
      json = looseJsonParse(raw);
      // Did we only get an answer because the salvage rescued a cut-off reply? Then part of his day
      // is genuinely missing, and he has to be told rather than shown a tidy-looking list. (BEA-1163)
      if (json && raw.trim() && !raw.trim().endsWith('}') && !raw.trim().endsWith('```')) truncated = true;
      if (!json && attempt === 0) this.log.warn(`mine(${day}) ${half}: unparseable model reply — retrying with a shorter ask`);
    }
    if (!json) this.log.warn(`mine(${day}) ${half}: unusable after retry`);
    return { json, truncated };
  }

  private async mineOnce(day: string, opts: { force?: boolean } = {}): Promise<MinedPayload> {
    const story = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    const text = (story?.rawText || '').trim();
    if (text.length < 15) return this.empty(day, !!story);

    /**
     * The stored reading, first. (BEA-1164)
     *
     * This read cost him ~30 seconds and a paid call, and it used to live only in the browser's
     * memory — so a reload, a dropped connection or a stumble in the wizard threw it away and
     * charged him again. On 28 July it ran SIX times for one day.
     *
     * His rule: *"it should not run api calls repeatedly."* So a stored reading always wins, even
     * when the story has since been edited — in that case it comes back flagged `stale` and the
     * wizard offers him the button. The app never decides on its own to spend another call.
     */
    const decision = cacheDecision({ stored: (story as any)?.mined, storedHash: (story as any)?.minedHash, currentText: text, force: opts.force });
    if (decision.use === 'cached') return { ...decision.payload, day, hasStory: true, cached: true, stale: decision.stale };

    // What's already logged, so the model doesn't re-propose known work.
    const [existing, openAll, contacts] = await Promise.all([
      this.prisma.task.findMany({ where: await this.tasks.whereForDay(day), select: { title: true } }),
      this.prisma.task.findMany({ where: { status: { not: 'done' } }, select: { title: true } }),
      this.contacts(),
    ]);
    const contactNames = contacts.map((c) => c.name).join(', ');

    /**
     * TWO reads, at the same time. (BEA-1166)
     *
     * This used to be one call doing eight jobs, and it took 20-30 seconds — the wait he said was
     * "bothering me a lot". The two halves share nothing, so neither has to wait for the other and
     * the wait becomes the slower of the two rather than the sum.
     *
     * It is also sturdier. One bad reply used to lose the whole day; now a failure in "the day"
     * still leaves him every task, and the wizard says which half is missing.
     */
    const diary = `DIARY:\n${text.slice(0, 6000)}`;
    // The task lists and contact names exist to stop the WORK half re-proposing known work and
    // misspelling a name. The day half reads feelings and a timeline — none of that helps it, and
    // sending it would spend input tokens on every read for nothing. (BEA-1166)
    const workContext =
      `Already logged: ${existing.map((t) => t.title).join(' | ') || '(none)'}\n` +
      `Open elsewhere: ${openAll.map((t) => t.title).slice(0, 60).join(' | ') || '(none)'}\n` +
      `Known contact names (for spelling only): ${contactNames || '(none)'}\n\n${diary}`;

    const model = await this.daily.storyModel();
    const [workPart, dayPart] = await Promise.all([
      this.readHalf(day, 'work', 'daily.storyMineWork', workContext, model),
      this.readHalf(day, 'day', 'daily.storyMineDay', diary, model),
    ]);

    // Only a total blank is a failure. Half an answer is still most of his day, and is far better
    // than throwing the lot away — which is exactly what the single call used to do.
    if (!workPart.json && !dayPart.json) {
      this.log.warn(`mine(${day}): both halves unusable after retry`);
      return { ...this.empty(day, true), failed: true }; // honest failure — never dressed up as a tidy day
    }
    const j: any = { ...(dayPart.json || {}), ...(workPart.json || {}) };
    const truncated = workPart.truncated || dayPart.truncated;
    const missing: 'work' | 'day' | null = !workPart.json ? 'work' : !dayPart.json ? 'day' : null;
    if (truncated) this.log.warn(`mine(${day}): reply was cut off — salvaged what was complete`);

    const S = (v: any, n = 160) => String(v || '').trim().slice(0, n);
    const dateOk = (v: any): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const arr = (v: any) => (Array.isArray(v) ? v : []);
    const num = (v: any): number | null => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null);

    // Dedup guard on top of the prompt: significant-word overlap vs everything already logged.
    const sig = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 3));
    const known = [...existing, ...openAll].map((t) => sig(t.title)).filter((x) => x.size);
    const isKnown = (title: string) => {
      const n = sig(title);
      if (!n.size) return false;
      return known.some((o) => {
        const inter = [...n].filter((w) => o.has(w)).length;
        const minSize = Math.min(n.size, o.size);
        return minSize >= 2 ? inter / minSize >= 0.6 : inter >= 1;
      });
    };

    const done = arr(j.done)
      .map((t: any) => ({ title: S(t?.title), category: S(t?.category, 40) || null }))
      .filter((t: any) => t.title && !isKnown(t.title))
      .slice(0, 12);
    const todos = arr(j.todos)
      .map((t: any) => ({ title: S(t?.title), category: S(t?.category, 40) || null, note: S(t?.note, 500) || null, priority: /^(high|medium|low)$/i.test(String(t?.priority)) ? String(t.priority).toLowerCase() : 'medium' }))
      .filter((t: any) => t.title && !isKnown(t.title))
      .slice(0, 12);
    // The never-guess rule: a delegation links to a contact ONLY on an exact name/alias match.
    const delegations = arr(j.delegations)
      .map((d: any) => {
        const name = S(d?.person, 60);
        const c = name ? matchContact(contacts, name) : null;
        return { contactName: c?.name || name, contactId: c?.id || null, title: S(d?.title), chase: d?.chase !== false };
      })
      .filter((d: any) => d.title && d.contactName && !isKnown(d.title))
      .slice(0, 10);
    const myReminders = arr(j.myReminders)
      .map((r: any) => ({ title: S(r?.title), date: dateOk(r?.date) }))
      .filter((r: any) => r.title && !isKnown(r.title))
      .slice(0, 8);
    const promises = arr(j.promises)
      .map((p: any) => {
        const to = S(p?.to, 60);
        const c = to ? matchContact(contacts, to) : null;
        return { to: c?.name || to, contactId: c?.id || null, what: S(p?.what), date: dateOk(p?.date) };
      })
      .filter((p: any) => p.what && p.to)
      .slice(0, 8);
    const emotions: MinedEmotions | null = j.emotions
      ? {
          lifted: arr(j.emotions.lifted).map((x: any) => S(x, 120)).filter(Boolean).slice(0, 5),
          drained: arr(j.emotions.drained).map((x: any) => S(x, 120)).filter(Boolean).slice(0, 5),
          energy: num(j.emotions.energy),
          worry: num(j.emotions.worry),
          feeling: S(j.emotions.feeling, 240) || null,
        }
      : null;
    const events = arr(j.events)
      .map((e: any) => ({ at: S(e?.at, 20) || null, title: S(e?.title, 200) }))
      .filter((e: any) => e.title)
      .slice(0, 10);
    const lessons = arr(j.lessons).map((x: any) => S(x, 300)).filter(Boolean).slice(0, 2);

    const payload: MinedPayload = { day, hasStory: true, partial: truncated, missing, done, todos, delegations, myReminders, promises, emotions, events, lessons };

    // Keep it, so this is the last time this story costs him a call or a wait. Stored against the
    // exact text it was read from. A failure to store must never lose him the reading he just
    // waited for, so it is best-effort. (BEA-1164)
    await this.prisma.story
      .update({ where: { id: story!.id }, data: { mined: JSON.stringify(payload), minedHash: storyFingerprint(text), minedAt: new Date() } })
      .catch(() => undefined);

    return payload;
  }

  /**
   * Apply exactly what the owner ticked. Everything goes through the existing doors so indexing,
   * chases and the delegation loop behave as if he had typed each item himself.
   */
  /** His chase times from Settings, not a constant in this file. (BEA-1161) */
  private async chaseTimes(): Promise<string[]> {
    const row = await this.prisma.setting.findUnique({ where: { key: TASK_SETTING_KEYS.chaseTimes } }).catch(() => null);
    return parseChaseTimes(row?.value);
  }

  async apply(day: string, picked: Partial<MinedPayload>): Promise<Record<string, number>> {
    const counts: Record<string, number> = { done: 0, todos: 0, delegations: 0, myReminders: 0, promises: 0, events: 0, lessons: 0, emotions: 0 };

    for (const t of (picked.done || []).slice(0, 20)) {
      const r = await this.tasks.createDoneTask(String(t?.title || ''), t?.category ?? null, day).catch(() => null);
      if (r) counts.done++;
    }
    for (const t of (picked.todos || []).slice(0, 20)) {
      const r = await this.tasks.create({ title: t.title, category: t.category || undefined, note: t.note || undefined, priority: (t as any).priority || 'medium', auto: true }).catch(() => null);
      if (r) counts.todos++;
    }
    for (const d of (picked.delegations || []).slice(0, 10)) {
      // Owned task only when the contact link is real; otherwise the person's name rides as display text.
      const task: any = await this.tasks
        .create({ title: d.title, ownerContactId: d.contactId || undefined, party: d.contactName, priority: 'medium', auto: true })
        .catch(() => null);
      if (!task) continue;
      counts.delegations++;
      if (d.chase && d.contactId) {
        await this.reminders
          .create({ contactId: d.contactId, taskId: task.id, subject: task.title, message: `Following up on: ${task.title}`, times: await this.chaseTimes(), repeat: 'daily' })
          .catch((e: any) => this.log.warn(`chase for "${d.title}" not created: ${e?.message ?? e}`));
      }
    }
    for (const r of (picked.myReminders || []).slice(0, 10)) {
      const t = await this.tasks.create({ title: r.title, day: r.date || undefined, priority: 'medium', auto: true }).catch(() => null);
      if (t) counts.myReminders++;
    }
    for (const p of (picked.promises || []).slice(0, 10)) {
      const t: any = await this.tasks.create({ title: p.what, party: p.to, priority: 'high', note: `Promised to ${p.to}${p.date ? ` by ${p.date}` : ''}`, auto: true }).catch(() => null);
      if (!t) continue;
      if (p.date) await this.prisma.task.update({ where: { id: t.id }, data: { promisedFor: p.date, promisedAt: new Date() } }).catch(() => undefined);
      counts.promises++;
    }
    if (picked.emotions) {
      const story = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
      if (story) {
        await this.prisma.story.update({ where: { id: story.id }, data: { emotions: JSON.stringify(picked.emotions) } }).catch(() => undefined);
        counts.emotions = 1;
      }
    }
    if (picked.events?.length) {
      // Replace this day's prior story-mined events — re-running the wizard must not duplicate the timeline.
      await this.prisma.dayEvent.deleteMany({ where: { day, source: 'story' } }).catch(() => undefined);
      for (const e of picked.events.slice(0, 12)) {
        const r = await this.prisma.dayEvent.create({ data: { day, at: e.at || null, title: e.title.slice(0, 200), source: 'story' } }).catch(() => null);
        if (r) counts.events++;
      }
    }
    for (const l of (picked.lessons || []).slice(0, 2)) {
      // A lesson lands in the Lab as a proposed finding — its own words, its own evidence trail.
      const r = await this.prisma.mindFinding
        .create({
          data: {
            statement: String(l).slice(0, 400),
            kind: 'behavioural',
            subject: 'his own account',
            relation: 'shows',
            object: 'a pattern',
            valence: 'neutral',
            confidence: 0.3,
            status: 'proposed',
            firstSeenDay: day,
            lastSeenDay: day,
          },
        })
        .catch(() => null);
      if (r) counts.lessons++;
    }
    return counts;
  }
}
