import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';

const EXTRACT_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' };
const DEFAULT_TZ = 'Asia/Kolkata';

function dayAdd(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const SYSTEM =
  `You extract accountability items from ONE day of someone's life. Be CONSERVATIVE — only pull CLEAR, explicit items; if unsure, leave it out.\n\n` +
  `COMMITMENT = something the person promised/agreed to DO (capture who it's to and by when, if stated).\n` +
  `DECISION = a clear choice that was made.\n\n` +
  `Return ONLY JSON (no prose, no code fences), shaped exactly:\n` +
  `{"commitments":[{"text":"short, in his voice","party":"who or null","due":"YYYY-MM-DD or null"}],"decisions":[{"text":"short","context":"one phrase or null"}]}\n` +
  `If nothing is clearly a commitment or decision, return {"commitments":[],"decisions":[]}.`;

@Injectable()
export class AccountabilityService implements OnModuleInit, OnModuleDestroy {
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  onModuleInit() {
    // Commitments folded into Tasks (BEA-605): the auto-extraction is OFF — promises now live as tasks
    // (with `party` + due) and the duplicate-prone commitment/decision extraction is retired. The methods
    // remain so the one-time migration (BEA-607) can still read existing rows.
  }
  onModuleDestroy() {
    if (this.tick) clearInterval(this.tick);
  }

  /** Extract for any of the last 2 days whose story exists and that we haven't processed yet. Idempotent. */
  private async autoTick(): Promise<void> {
    const today = await this.todayKey();
    const setting = await this.prisma.setting.findUnique({ where: { key: 'accountability.extracted' } }).catch(() => null);
    let done: string[] = [];
    try {
      done = setting?.value ? JSON.parse(setting.value) : [];
    } catch {
      done = [];
    }
    let changed = false;
    for (const day of [dayAdd(today, -1), today]) {
      if (done.includes(day)) continue;
      const has = (await this.prisma.story.findFirst({ where: { day } })) || (await this.prisma.dayStory.findUnique({ where: { day } }).catch(() => null));
      if (!has) continue;
      await this.extractForDay(day).catch(() => undefined);
      done.push(day);
      changed = true;
    }
    if (changed) {
      const trimmed = done.slice(-30);
      await this.prisma.setting
        .upsert({ where: { key: 'accountability.extracted' }, create: { key: 'accountability.extracted', value: JSON.stringify(trimmed) }, update: { value: JSON.stringify(trimmed) } })
        .catch(() => undefined);
    }
  }

  private norm(s: string): string {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  private async todayKey(): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'tasks.tz' } }).catch(() => null);
    const tz = row?.value || DEFAULT_TZ;
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  /** Extract commitments + decisions from one day's story/summary/tasks. Conservative + de-duped. (BEA-355) */
  async extractForDay(dayIn?: string): Promise<{ commitments: number; decisions: number; day: string }> {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(dayIn || '') ? (dayIn as string) : await this.todayKey();
    const [story, summary, dayStory, tasks] = await Promise.all([
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.daySummary.findUnique({ where: { day } }).catch(() => null),
      this.prisma.dayStory.findUnique({ where: { day } }).catch(() => null),
      this.prisma.task.findMany({ where: { day } }),
    ]);
    const material = [
      (story?.rawText || dayStory?.text) && `His story:\n${(story?.rawText || dayStory?.text || '').slice(0, 4000)}`,
      summary?.text && `Day summary:\n${summary.text.slice(0, 2000)}`,
      tasks.length && `Tasks today:\n${tasks.map((t) => `- ${t.title}${t.note ? ` (${t.note})` : ''}`).join('\n')}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!material.trim()) return { commitments: 0, decisions: 0, day };

    const raw = (await this.llm.completeWith(await this.model(), `${SYSTEM}\n\n=== THE DAY (${day}) ===\n${material}`, 800, 'commitments-extract'))?.trim() || '';
    let parsed: any;
    try {
      parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    } catch {
      return { commitments: 0, decisions: 0, day };
    }
    const newC = Array.isArray(parsed?.commitments) ? parsed.commitments : [];
    const newD = Array.isArray(parsed?.decisions) ? parsed.decisions : [];

    const [existC, existD] = await Promise.all([
      this.prisma.commitment.findMany({ where: { status: { not: 'dropped' } }, select: { text: true } }),
      this.prisma.decision.findMany({ select: { text: true } }),
    ]);
    const seenC = new Set(existC.map((x) => this.norm(x.text)));
    const seenD = new Set(existD.map((x) => this.norm(x.text)));

    let commitments = 0;
    let decisions = 0;
    for (const c of newC) {
      const text = String(c?.text || '').trim();
      if (!text || seenC.has(this.norm(text))) continue;
      seenC.add(this.norm(text));
      await this.prisma.commitment.create({
        data: {
          text: text.slice(0, 500),
          party: c?.party && String(c.party).toLowerCase() !== 'null' ? String(c.party).slice(0, 120) : null,
          dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(c?.due)) ? c.due : null,
          source: 'story',
          sourceDay: day,
        },
      });
      commitments++;
    }
    for (const d of newD) {
      const text = String(d?.text || '').trim();
      if (!text || seenD.has(this.norm(text))) continue;
      seenD.add(this.norm(text));
      await this.prisma.decision.create({
        data: { text: text.slice(0, 500), context: d?.context && String(d.context).toLowerCase() !== 'null' ? String(d.context).slice(0, 300) : null, source: 'story', sourceDay: day },
      });
      decisions++;
    }
    return { commitments, decisions, day };
  }

  async listCommitments(filter = 'all'): Promise<any[]> {
    const today = await this.todayKey();
    const rows = await this.prisma.commitment.findMany({ orderBy: [{ createdAt: 'desc' }] });
    const shaped = rows.map((c) => ({ ...c, overdue: c.status === 'open' && !!c.dueDate && c.dueDate < today }));
    if (filter === 'open') return shaped.filter((c) => c.status === 'open');
    if (filter === 'overdue') return shaped.filter((c) => c.overdue);
    if (filter === 'done') return shaped.filter((c) => c.status === 'done');
    return shaped;
  }

  listDecisions() {
    return this.prisma.decision.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
  }

  async setStatus(id: string, status: string) {
    if (!['open', 'done', 'dropped'].includes(status)) return null;
    return this.prisma.commitment
      .update({ where: { id }, data: { status, completedAt: status === 'done' ? new Date() : null } })
      .catch(() => null);
  }

  confirm(id: string) {
    return this.prisma.commitment.update({ where: { id }, data: { confirmed: true } }).catch(() => null);
  }

  async removeCommitment(id: string) {
    await this.prisma.commitment.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }
  async removeDecision(id: string) {
    await this.prisma.decision.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  // ---- engine picker (own model; defaults to Haiku — a tiny job — can run free on Codex/Gemini) ----
  async model(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'accountability.llm' } });
    if (row) {
      try {
        const v = JSON.parse(row.value);
        if (v?.provider && v?.model) return v;
      } catch {
        /* ignore */
      }
    }
    return EXTRACT_MODEL;
  }
  async setModel(provider: string, model: string): Promise<LlmConfig> {
    const cfg = this.llm.agentConfig(provider, model);
    await this.prisma.setting.upsert({ where: { key: 'accountability.llm' }, create: { key: 'accountability.llm', value: JSON.stringify(cfg) }, update: { value: JSON.stringify(cfg) } });
    return cfg;
  }
  async listModels() {
    return this.llm.listOpenRouterModels(['openai/', 'anthropic/']);
  }
}
