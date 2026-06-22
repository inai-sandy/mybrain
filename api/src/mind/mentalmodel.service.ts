import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { MindIngestionService } from './ingestion.service';
import { DaySignals } from './mind.types';

// The reasoning model defaults to Sonnet — this is the "no basic stuff" core, it needs real reasoning.
const MODEL_KEY = 'mind.llm';
const DEFAULT_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };

const SYSTEM = `You are a rigorous behavioural scientist building a model of ONE person from their own day.
You receive a day's signals — tasks they DID, tasks they POSTPONED (deferred repeatedly), tasks they SKIPPED
(planned but never did), what they CAPTURED, and their own STORY of the day with its mood — plus the
hypotheses you already hold about them.

Infer well-grounded HYPOTHESES about this person, above all by correlating their ACTIONS and INACTIONS with
their FEELINGS. Inaction — what they avoid, defer, abandon — is the richest signal; weight it heavily. Look for
causal, emotional, relational and temporal patterns.

Rules:
- Ground every hypothesis in THIS day's concrete evidence. No generic pop-psychology, no flattery.
- Be specific: "money/admin tasks drain you and you keep deferring them" beats "you procrastinate".
- If today supports a hypothesis you already hold, REINFORCE it (set reinforcesId to its id) — do not duplicate.
- Confidence reflects how strongly this single day's evidence supports it: 0.1–0.6 for one day.
- Never re-propose anything listed under REFUTED.
- Return AT MOST 8 findings — only the well-supported ones.

Return ONLY JSON, no prose:
{"findings":[{"reinforcesId":"<existing id or null>","statement":"...","kind":"emotional|behavioural|relational|temporal|causal","subject":"...","relation":"...","object":"...","valence":"energizing|draining|neutral","confidence":0.0,"cadence":"daily|weekly|situational|null","evidence":[{"signal":"done|postponed|skipped|told|created","snippet":"..."}]}]}`;

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
  private lastRunDay = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly ingestion: MindIngestionService,
  ) {}

  onModuleInit() {
    // Nightly-ish: reflect on YESTERDAY once a day (its story is finalised at 23:58). Hourly check, guarded.
    this.timer = setInterval(() => this.nightly().catch((e) => this.log.warn(`mind nightly: ${e?.message ?? e}`)), 60 * 60 * 1000);
  }

  private ymd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private async nightly(): Promise<void> {
    const yesterday = this.ymd(new Date(Date.now() - 86_400_000));
    if (this.lastRunDay === yesterday) return;
    this.lastRunDay = yesterday;
    const r = await this.run(yesterday);
    if (r.proposed || r.reinforced) this.log.log(`mind: ${yesterday} → ${r.proposed} new, ${r.reinforced} reinforced`);
  }

  private async model(): Promise<LlmConfig> {
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

  /** Run the mental model for one day: ingest → reason (LLM) → reconcile into the mind graph. */
  async run(day: string): Promise<{ proposed: number; reinforced: number }> {
    const signals = await this.ingestion.gatherDaySignals(day);
    if (!signals.hasSignal) return { proposed: 0, reinforced: 0 };

    const existing = await this.prisma.mindFinding.findMany({
      where: { status: { in: ['proposed', 'emerging', 'established'] }, NOT: { validated: 'refuted' } },
      select: { id: true, statement: true, confidence: true, evidenceCount: true, status: true },
      orderBy: { confidence: 'desc' },
      take: 60,
    });
    const refuted = await this.prisma.mindFinding.findMany({ where: { validated: 'refuted' }, select: { statement: true }, take: 40 });

    const prompt =
      `${SYSTEM}\n\n=== THE DAY (${day}) ===\n${this.formatSignals(signals)}\n\n` +
      `=== HYPOTHESES YOU ALREADY HOLD (reinforce by id, don't duplicate) ===\n` +
      (existing.length ? existing.map((e) => `${e.id}: ${e.statement}`).join('\n') : '(none yet)') +
      (refuted.length ? `\n\n=== REFUTED (never re-propose) ===\n${refuted.map((r) => `- ${r.statement}`).join('\n')}` : '');

    const raw = (await this.llm.completeWith(await this.model(), prompt, 1800, 'mind-model'))?.trim() || '';
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
            lastSeenDay: day,
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
    return { proposed, reinforced };
  }

  private normSignal(s?: string): string {
    return ['done', 'postponed', 'skipped', 'told', 'created'].includes(String(s)) ? (s as string) : 'told';
  }

  private async addEvidence(findingId: string, ev: { sourceType: string; sourceId: string | null; day: string; signal: string; snippet: string }[]) {
    if (!ev.length) return;
    await this.prisma.mindEvidence.createMany({ data: ev.map((e) => ({ findingId, ...e })) }).catch(() => undefined);
  }

  /** Parse + guard the LLM JSON. A bad response never corrupts the store — it just yields nothing. */
  private parse(raw: string): RawFinding[] {
    try {
      const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const obj = JSON.parse(json);
      return Array.isArray(obj?.findings) ? (obj.findings as RawFinding[]) : [];
    } catch {
      return [];
    }
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
      s.story ? `STORY (mood: ${s.story.mood || '—'}${s.story.workedMinutes ? `, worked ${s.story.workedMinutes}m` : ''}):\n  ${s.story.rawText.slice(0, 2500)}` : '',
      s.daySummary ? `DAY SUMMARY:\n  ${s.daySummary.slice(0, 1200)}` : '',
    ].filter(Boolean);
    return parts.join('\n\n');
  }
}
