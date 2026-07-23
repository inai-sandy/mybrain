import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { MindIngestionService } from './ingestion.service';
import { MindLifecycleService } from './lifecycle.service';
import { MindChainService } from './chain.service';
import { PromptsService } from '../prompts/prompts.service';
import { DaySignals } from './mind.types';

// The reasoning model defaults to Sonnet — this is the "no basic stuff" core, it needs real reasoning.
const MODEL_KEY = 'mind.llm';
const LEARNED_KEY = 'mind.learnedDays'; // closed days the Lab has already reflected on (BEA-458)
const ABOUT_KEY = 'mind.aboutMe'; // the user's own words about who they are (BEA-463)
const DEFAULT_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };

type RawFinding = {
  reinforcesId?: string | null;
  statement?: string;
  kind?: string;
  subject?: string;
  relation?: string;
  object?: string;
  valence?: string;
  confidence?: number;
  cadence?: string | null;
  evidence?: { signal?: string; snippet?: string }[];
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const KINDS = ['emotional', 'behavioural', 'relational', 'temporal', 'causal'];
const VALENCE = ['energizing', 'draining', 'neutral'];

@Injectable()
export class MentalModelService implements OnModuleInit {
  private readonly log = new Logger('MentalModelService');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly ingestion: MindIngestionService,
    private readonly lifecycle: MindLifecycleService,
    private readonly chains: MindChainService,
    private readonly prompts: PromptsService,
  ) {}

  onModuleInit() {
    // Learn from CLOSED days, not a blind clock: you often fill a day in the next morning, so we only reflect
    // once you've closed it (closeDay also triggers us directly). Hourly catch-up handles any missed closes. (BEA-458)
    this.timer = setInterval(() => this.catchUp().catch((e) => this.log.warn(`mind catchup: ${e?.message ?? e}`)), 60 * 60 * 1000);
  }

  private ymd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  /** Today's IST day key — used for lifecycle/decay so a finding confirmed late at night isn't
   *  stamped with the previous UTC day and made to decay early. (BEA-813) */
  private todayIst(): string {
    return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  }

  // ---- closed-day bookkeeping (BEA-458) ----
  private async learnedSet(): Promise<Set<string>> {
    const row = await this.prisma.setting.findUnique({ where: { key: LEARNED_KEY } }).catch(() => null);
    try {
      const arr = JSON.parse(row?.value || '[]');
      return new Set(Array.isArray(arr) ? (arr as string[]) : []);
    } catch {
      return new Set();
    }
  }

  private async markLearned(day: string): Promise<void> {
    const set = await this.learnedSet();
    set.add(day);
    // Keep the FULL set of learned days. The old 150-day cap dropped older days, so once >150 days
    // were closed they fell out of the set and catchUp() re-learned them (a fresh LLM pass) every
    // hour, forever — a runaway. One short date string per closed day is tiny. (BEA-780)
    const value = JSON.stringify([...set].sort());
    await this.prisma.setting.upsert({ where: { key: LEARNED_KEY }, create: { key: LEARNED_KEY, value }, update: { value } }).catch(() => undefined);
  }

  private async closedDays(): Promise<string[]> {
    const rows = await this.prisma.dayClose.findMany({ select: { day: true }, orderBy: { day: 'asc' } }).catch(() => [] as { day: string }[]);
    return rows.map((r) => r.day);
  }

  /** Record a run so the user can see WHEN the Lab worked (Settings → Activity). (BEA-468) */
  private async logRun(day: string, r: { proposed: number; reinforced: number } | null): Promise<void> {
    const detail = r ? `${r.proposed} new, ${r.reinforced} reinforced` : "couldn't read that day";
    await this.prisma.mindRun.create({ data: { kind: 'learn', day, detail } }).catch(() => undefined);
  }

  /** Reflect on ONE day and remember it — called the moment a day is CLOSED (morning or night). (BEA-458) */
  async learnDay(day: string, skippedOverride?: any[]): Promise<{ proposed: number; reinforced: number }> {
    const r = await this.run(day, skippedOverride);
    await this.markLearned(day);
    await this.logRun(day, r);
    if (r.proposed || r.reinforced) this.log.log(`mind: learned ${day} → ${r.proposed} new, ${r.reinforced} reinforced`);
    await this.lifecycle.runDaily(this.todayIst()).catch((e) => this.log.warn(`mind lifecycle: ${e?.message ?? e}`));
    await this.chains.inferFromDay(day).catch((e) => this.log.warn(`mind chains: ${e?.message ?? e}`)); // propose blocker/lever chains (BEA-516)
    await this.chains.reviewActiveChains(day).catch((e) => this.log.warn(`mind chains review: ${e?.message ?? e}`)); // re-derive shifted/resolved blockers — ToC "repeat" (BEA-526)
    return r;
  }

  /** "What I connected" — what the Lab learned on the most recently closed day, for the Lab recap banner. (BEA-544) */
  async recap() {
    const lastClose = await this.prisma.dayClose.findFirst({ orderBy: { day: 'desc' } }).catch(() => null);
    if (!lastClose) return { day: null as string | null, findings: [], situationsAdded: [], situationsUpdated: [] };
    const day = lastClose.day;
    const [findings, added, updated] = await Promise.all([
      this.prisma.mindFinding.findMany({ where: { firstSeenDay: day, status: { not: 'retired' }, NOT: { validated: 'refuted' } }, orderBy: { confidence: 'desc' }, take: 6, select: { statement: true, valence: true } }),
      this.prisma.mindChain.findMany({ where: { firstSeenDay: day, status: { not: 'retired' } }, select: { goal: true, lever: true, provenance: true } }),
      this.prisma.mindChain.findMany({ where: { lastSeenDay: day, shifted: true, status: { not: 'retired' }, NOT: { firstSeenDay: day } }, select: { goal: true, blocker: true } }),
    ]);
    return { day, findings, situationsAdded: added, situationsUpdated: updated };
  }

  /** Hourly catch-up: reflect on any CLOSED day we haven't learned yet (e.g. closed while the app was down). */
  private async catchUp(): Promise<void> {
    const learned = await this.learnedSet();
    const todo = (await this.closedDays()).filter((d) => !learned.has(d));
    if (!todo.length) return;
    for (const day of todo) {
      const r = await this.run(day).catch((e) => {
        this.log.warn(`mind learn ${day}: ${e?.message ?? e}`);
        return null;
      });
      await this.markLearned(day); // mark even on an empty/failed pass so we don't reprocess it forever
      await this.logRun(day, r);
      if (r && (r.proposed || r.reinforced)) this.log.log(`mind: learned ${day} → ${r.proposed} new, ${r.reinforced} reinforced`);
    }
    await this.lifecycle.runDaily(this.todayIst()).catch((e) => this.log.warn(`mind lifecycle: ${e?.message ?? e}`));
  }

  /** "Run now": learn every closed-but-unlearned day; if all caught up, re-reflect on the latest closed day. (BEA-458) */
  async runNow(): Promise<{ proposed: number; reinforced: number; days: number }> {
    const learned = await this.learnedSet();
    const closed = await this.closedDays();
    let targets = closed.filter((d) => !learned.has(d));
    if (!targets.length) targets = closed.length ? [closed[closed.length - 1]] : [this.ymd(new Date(Date.now() - 86_400_000))];
    let proposed = 0;
    let reinforced = 0;
    for (const day of targets) {
      const r = await this.run(day).catch(() => null);
      await this.markLearned(day);
      await this.logRun(day, r);
      if (r) {
        proposed += r.proposed;
        reinforced += r.reinforced;
      }
    }
    await this.lifecycle.runDaily(this.todayIst()).catch(() => undefined);
    return { proposed, reinforced, days: targets.length };
  }

  /** The engine that reasons about you — own picker (Setting `mind.llm`), defaults to Sonnet. (BEA-452) */
  async model(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: MODEL_KEY } }).catch(() => null);
    if (row?.value) {
      try {
        const v = JSON.parse(row.value);
        if (v?.provider && v?.model) return v;
      } catch {
        /* fall through */
      }
    }
    return DEFAULT_MODEL;
  }

  /** Set the Lab engine; the picker id resolves the free Codex/Gemini agents via agentConfig. */
  async setModel(provider: string, model: string): Promise<LlmConfig> {
    const cfg = this.llm.agentConfig(provider, model);
    const value = JSON.stringify(cfg);
    await this.prisma.setting.upsert({ where: { key: MODEL_KEY }, create: { key: MODEL_KEY, value }, update: { value } });
    return cfg;
  }

  /** OpenAI + Anthropic models for the Settings picker (agent engines added by the card). */
  listModels() {
    return this.llm.listOpenRouterModels(['openai/', 'anthropic/']);
  }

  /** The user's own words about who they are — grounds the engine + the Mentor. (BEA-463) */
  async aboutMe(): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: ABOUT_KEY } }).catch(() => null);
    return (row?.value || '').trim();
  }

  async setAboutMe(text: string): Promise<string> {
    const value = (text || '').slice(0, 6000);
    await this.prisma.setting.upsert({ where: { key: ABOUT_KEY }, create: { key: ABOUT_KEY, value }, update: { value } });
    return value.trim();
  }

  /** A compact, plain-English digest of the strongest findings — for grounding the Mentor. (BEA-454) */
  async summaryForMentor(limit = 12): Promise<string> {
    const about = await this.aboutMe();
    const rows = await this.prisma.mindFinding.findMany({
      where: { status: { in: ['established', 'emerging'] }, NOT: { validated: 'refuted' } },
      orderBy: [{ confidence: 'desc' }],
      take: limit,
      select: { statement: true, valence: true, confidence: true },
    });
    const findingLines = rows.map((r) => `- ${r.statement} (${r.valence}, ${Math.round(r.confidence * 100)}% sure)`).join('\n');
    const chainLines = await this.chains.summaryForMentor(6); // the Situation levers (BEA-517)
    const aboutBlock = about ? `In their own words, about who they are:\n${about}` : '';
    return [
      aboutBlock,
      findingLines && `What the Lab has learned about them:\n${findingLines}`,
      chainLines && `Their real situation — what's blocked and the LEVER that unblocks it (plan around the levers; don't nag them about the blocked goals until the lever moves):\n${chainLines}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** Run the mental model for one day: ingest → reason (LLM) → reconcile into the mind graph. */
  async run(day: string, skippedOverride?: any[]): Promise<{ proposed: number; reinforced: number }> {
    const signals = await this.ingestion.gatherDaySignals(day, undefined, skippedOverride);
    if (!signals.hasSignal) return { proposed: 0, reinforced: 0 };

    const existing = await this.prisma.mindFinding.findMany({
      where: { status: { in: ['proposed', 'emerging', 'established'] }, NOT: { validated: 'refuted' } },
      select: { id: true, statement: true, confidence: true, evidenceCount: true, status: true, lastSeenDay: true },
      orderBy: { confidence: 'desc' },
      take: 60,
    });
    const refuted = await this.prisma.mindFinding.findMany({ where: { validated: 'refuted' }, select: { statement: true }, take: 40 });
    const about = await this.aboutMe();
    // The user's own notes on existing findings — their words override your guesses. (BEA-464)
    const notes = existing.length
      ? await this.prisma.mindEvidence.findMany({ where: { signal: 'feedback', findingId: { in: existing.map((e) => e.id) } }, select: { findingId: true, snippet: true }, orderBy: { createdAt: 'desc' }, take: 40 })
      : [];
    const noteBy = new Map<string, string[]>();
    for (const n of notes) (noteBy.get(n.findingId) ?? noteBy.set(n.findingId, []).get(n.findingId)!).push(n.snippet || '');

    const tmpl = await this.prompts.get('lab.model');
    const prompt =
      `${tmpl}\n\n` +
      (about ? `=== WHAT THIS PERSON SAYS ABOUT THEMSELVES (their own words — weigh this heavily) ===\n${about}\n\n` : '') +
      `=== THE DAY (${day}) ===\n${this.formatSignals(signals)}\n\n` +
      `=== HYPOTHESES YOU ALREADY HOLD (reinforce by id, don't duplicate) ===\n` +
      (existing.length ? existing.map((e) => `${e.id}: ${e.statement}${noteBy.has(e.id) ? ` — the user told you in their own words: "${noteBy.get(e.id)!.join('; ')}"` : ''}`).join('\n') : '(none yet)') +
      (refuted.length ? `\n\n=== REFUTED (never re-propose) ===\n${refuted.map((r) => `- ${r.statement}`).join('\n')}` : '');

    const raw = (await this.llm.completeWith(await this.model(), prompt, 4000, 'mind-model'))?.trim() || '';
    const findings = this.parse(raw);
    if (!findings.length) return { proposed: 0, reinforced: 0 };

    const existingIds = new Set(existing.map((e) => e.id));
    let proposed = 0;
    let reinforced = 0;
    for (const f of findings.slice(0, 8)) {
      if (!f.statement || !f.subject || !f.relation || !f.object) continue;
      const kind = KINDS.includes(String(f.kind)) ? (f.kind as string) : 'behavioural';
      const valence = VALENCE.includes(String(f.valence)) ? (f.valence as string) : 'neutral';
      const cadence = f.cadence && ['daily', 'weekly', 'situational'].includes(String(f.cadence)) ? (f.cadence as string) : null;
      const conf = clamp(typeof f.confidence === 'number' ? f.confidence : 0.25, 0.1, 0.6);
      const evidence = (f.evidence || []).slice(0, 5).map((e) => ({ sourceType: 'day', sourceId: null, day, signal: this.normSignal(e.signal), snippet: (e.snippet || '').slice(0, 300) }));

      if (f.reinforcesId && existingIds.has(f.reinforcesId)) {
        const cur = existing.find((e) => e.id === f.reinforcesId)!;
        const newConf = Math.min(0.98, cur.confidence + (1 - cur.confidence) * 0.25); // diminishing reinforcement
        await this.prisma.mindFinding.update({
          where: { id: cur.id },
          data: {
            confidence: newConf,
            evidenceCount: cur.evidenceCount + 1,
            // Never move freshness backwards when reflecting on an older day, or a daily-cadence
            // finding would falsely start to decay. Keep the later of the two. (BEA-780)
            lastSeenDay: cur.lastSeenDay && cur.lastSeenDay > day ? cur.lastSeenDay : day,
            trend: 'rising',
            status: cur.status === 'proposed' && newConf >= 0.4 ? 'emerging' : cur.status,
          },
        });
        await this.addEvidence(cur.id, evidence);
        reinforced++;
      } else {
        const created = await this.prisma.mindFinding.create({
          data: {
            statement: f.statement.slice(0, 400),
            kind,
            subject: f.subject.slice(0, 120),
            relation: f.relation.slice(0, 60),
            object: f.object.slice(0, 120),
            valence,
            confidence: conf,
            evidenceCount: 1,
            status: conf >= 0.4 ? 'emerging' : 'proposed',
            cadence,
            trend: 'rising',
            firstSeenDay: day,
            lastSeenDay: day,
          },
        });
        await this.addEvidence(created.id, evidence);
        proposed++;
      }
    }
    // Fold any near-duplicates the model just created into existing ones, so the list never piles up. (BEA-459)
    if (proposed) await this.lifecycle.consolidate().catch((e) => this.log.warn(`mind consolidate: ${e?.message ?? e}`));
    return { proposed, reinforced };
  }

  private normSignal(s?: string): string {
    return ['done', 'postponed', 'skipped', 'told', 'created'].includes(String(s)) ? (s as string) : 'told';
  }

  private async addEvidence(findingId: string, ev: { sourceType: string; sourceId: string | null; day: string; signal: string; snippet: string }[]) {
    if (!ev.length) return;
    await this.prisma.mindEvidence.createMany({ data: ev.map((e) => ({ findingId, ...e })) }).catch(() => undefined);
  }

  /** Parse + guard the LLM JSON. Tolerates a TRUNCATED response by salvaging the complete findings.
   *  A bad response never corrupts the store — it just yields nothing. */
  private parse(raw: string): RawFinding[] {
    const start = raw.indexOf('{');
    if (start < 0) return [];
    const body = raw.slice(start);
    const tryParse = (s: string): RawFinding[] | null => {
      try {
        const o = JSON.parse(s);
        return Array.isArray(o?.findings) ? (o.findings as RawFinding[]) : null;
      } catch {
        return null;
      }
    };
    // 1) Clean response → to the last closing brace.
    const whole = tryParse(body.slice(0, body.lastIndexOf('}') + 1));
    if (whole) return whole;
    // 2) Truncated mid-array → cut at the last COMPLETE finding object and re-close the array + object.
    const lastObj = body.lastIndexOf('}');
    if (lastObj > 0) {
      const salvaged = tryParse(body.slice(0, lastObj + 1) + ']}');
      if (salvaged) return salvaged;
    }
    return [];
  }

  private formatSignals(s: DaySignals): string {
    const tl = (arr: { title: string; rolloverCount?: number; category?: string | null }[], withRoll = false) =>
      arr.length ? arr.map((t) => `  - ${t.title}${t.category ? ` [${t.category}]` : ''}${withRoll && t.rolloverCount ? ` (deferred ${t.rolloverCount}×)` : ''}`).join('\n') : '  (none)';
    const parts = [
      `DID (completed):\n${tl(s.tasks.done)}`,
      `POSTPONED (deferred again and again — avoidance):\n${tl(s.tasks.postponed, true)}`,
      `SKIPPED (planned, never done):\n${tl(s.tasks.skipped)}`,
      `CAPTURED today:\n${tl(s.tasks.created)}`,
      s.ideas.length ? `IDEAS:\n${s.ideas.map((i) => `  - ${i.title}`).join('\n')}` : '',
      s.meetings.length ? `MEETINGS:\n${s.meetings.map((m) => `  - ${m.title}${m.summary ? `: ${m.summary.slice(0, 200)}` : ''}${m.decisions.length ? ` [decisions: ${m.decisions.join('; ')}]` : ''}`).join('\n')}` : '',
      s.emails.length ? `IMPORTANT EMAILS:\n${s.emails.map((e) => `  - from ${e.from}: ${e.subject}`).join('\n')}` : '',
      s.story ? `STORY (mood: ${s.story.mood || '—'}${s.story.workedMinutes ? `, worked ${s.story.workedMinutes}m` : ''}):\n  ${s.story.rawText.slice(0, 2500)}` : '',
      s.daySummary ? `DAY SUMMARY:\n  ${s.daySummary.slice(0, 1200)}` : '',
    ].filter(Boolean);
    return parts.join('\n\n');
  }
}
