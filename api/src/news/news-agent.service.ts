import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentAreasService } from '../agent/agent-areas.service';
import { AgentService } from '../agent/agent.service';

/**
 * AI News Daily, as an agent (BEA-1259).
 *
 * The owner asked for this to live in Agents, and it does: an area, one job, one flow, running
 * itself at noon. What it does NOT do is let the planner near it. The flow is hand-drawn, correct,
 * and marked `locked` — one press of Auto-plan would replace `news_collect` / `news_write` /
 * `news_flag` with generic web-search branches and silently throw the whole pipeline away. That is
 * not a hypothetical: BEA-1246 is the same failure, where re-planning quietly downgraded a research
 * flow to a single index.
 *
 * Everything here is idempotent, so it can run on boot without making a second agent each time.
 */

export const NEWS_AGENT_NAME = 'AI News Daily';
export const NEWS_FLOW_NAME = 'AI News Daily — every day at noon';
/** 12:00 in the owner's timezone. The feed publishes 11:14 IST, so noon is comfortably after. */
export const NEWS_SCHEDULE = { every: 'day' as const, at: '12:00' };
/** Where we remember what we made, so a rename cannot make us build a second one. */
const IDS_KEY = 'news.agent.ids';
/** Set once the first automatic setup succeeds — deleting the agent then keeps it deleted. */
const SETUP_KEY = 'news.agent.setupAt';

const TOOLS = [
  { id: 'news_collect', name: 'Collect the AI news', group: 'News', kind: 'api', note: 'Pull the feed, split every story out and file each one into a category', status: 'installed' },
  { id: 'news_write', name: 'Write the edition', group: 'News', kind: 'api', note: "Turn the categorised stories into the day's edition", status: 'installed' },
  { id: 'news_flag', name: 'Pick what needs research', group: 'News', kind: 'api', note: 'Shortlist the few stories worth a proper dig', status: 'installed' },
];

/** The flow, drawn by hand: three real steps in a line, then the output. */
export function newsGraph() {
  const X = 320;
  const step = (i: number, id: string, label: string, sub: string) => ({
    id,
    type: 'box',
    position: { x: X, y: 120 + i * 120 },
    data: { kind: 'tool', label, refId: id, sub },
  });
  const nodes: any[] = [
    { id: 'question', type: 'box', position: { x: X, y: 0 }, data: { kind: 'question', label: 'Question', sub: "What happened in AI today, and what is worth digging into?" } },
    step(0, 'news_collect', 'Collect the AI news', 'Fetch the feed, split out every story, file each into a category'),
    step(1, 'news_write', 'Write the edition', 'Headline, the 60-second read, and a section per category'),
    step(2, 'news_flag', 'Pick what needs research', 'Shortlist the few worth a proper dig'),
    { id: 'output', type: 'box', position: { x: X, y: 480 }, data: { kind: 'output', label: 'Output' } },
  ];
  const order = ['question', 'news_collect', 'news_write', 'news_flag', 'output'];
  const edges = order.slice(0, -1).map((from, i) => ({ id: `e_${from}_${order[i + 1]}`, source: from, target: order[i + 1], animated: true }));
  return { nodes, edges };
}

@Injectable()
export class NewsAgentService implements OnModuleInit {
  private readonly log = new Logger('NewsAgent');

  constructor(
    private readonly prisma: PrismaService,
    private readonly areas?: AgentAreasService,
    private readonly agentSvc?: AgentService,
  ) {}

  onModuleInit() {
    // Detached on purpose: setup must never delay or block the app starting.
    void this.ensureOnce();
  }

  /**
   * Make sure the agent, its job and its locked, scheduled flow all exist. Safe to run repeatedly:
   * it finds what it made last time by id, falling back to name, rather than building another.
   */
  async ensure(): Promise<{ areaId: string; jobId: string; flowId: string; created: boolean }> {
    if (!this.areas || !this.agentSvc) throw new Error('the agent module is not available on this server');

    // Remembered ids come first, names second. Matching on name alone meant renaming the job — a
    // perfectly ordinary thing to do — made the next setup fail to find it, build a SECOND job and
    // a second locked, scheduled flow, and then two editions would publish at noon.
    const saved = await this.savedIds();
    const rows: any[] = await (this.prisma as any).agentArea.findMany({ select: { id: true, name: true } });
    const existingArea =
      (saved.areaId && rows.find((r) => r.id === saved.areaId)) ||
      rows.find((r) => String(r.name).trim().toLowerCase() === NEWS_AGENT_NAME.toLowerCase());
    let created = false;

    let areaId: string;
    if (existingArea) {
      areaId = existingArea.id;
    } else {
      const area: any = await this.areas.create({
        name: NEWS_AGENT_NAME,
        icon: '📰',
        color: '#f59e0b',
        description: "Every day at noon: the whole AI news feed, split, filed into your categories and written up as one edition.",
        outcome: 'Every story in the day\'s feed appears in the edition, filed under a category, with a headline and a 60-second read.',
        tools: TOOLS as any,
      } as any);
      areaId = area.id;
      created = true;
    }

    // The job.
    const jobs: any[] = await (this.prisma as any).agent.findMany({ where: { areaId }, select: { id: true, name: true } });
    let job =
      (saved.jobId && jobs.find((j) => j.id === saved.jobId)) ||
      jobs.find((j) => String(j.name).trim().toLowerCase() === NEWS_AGENT_NAME.toLowerCase());
    if (!job) {
      job = await this.agentSvc.createAgent({
        areaId,
        name: NEWS_AGENT_NAME,
        icon: '📰',
        description: "Read the day's AI news and write the edition.",
        prompt:
          'Collect the day\'s AI news, file every story into a category, write the edition, and shortlist what is worth researching. ' +
          'Every story in the feed must appear — nothing is dropped.',
        autonomy: 'balanced',
      } as any);
      created = true;
    }

    // The flow — hand-drawn, locked, and scheduled.
    const flows: any[] = await this.prisma.flow.findMany({ where: { agentId: job.id } });
    let flow = flows.find((f) => f.name === NEWS_FLOW_NAME) || flows[0];
    const graph = JSON.stringify(newsGraph());
    if (!flow) {
      flow = await this.prisma.flow.create({
        data: {
          name: NEWS_FLOW_NAME,
          question: 'What happened in AI today, and what is worth digging into?',
          agentId: job.id,
          graph,
          schedule: JSON.stringify(NEWS_SCHEDULE),
          locked: true,
        },
      });
      created = true;
      this.log.log(`created the AI News Daily flow, locked and scheduled for ${NEWS_SCHEDULE.at}`);
    } else if (!flow.locked || !flow.schedule) {
      // Repair rather than replace: an unlocked or unscheduled flow is one Auto-plan away from
      // losing the pipeline, and one restart away from never running.
      flow = await this.prisma.flow.update({
        where: { id: flow.id },
        data: { locked: true, schedule: flow.schedule || JSON.stringify(NEWS_SCHEDULE) },
      });
    }

    await this.remember({ areaId, jobId: job.id, flowId: flow.id });
    return { areaId, jobId: job.id, flowId: flow.id, created };
  }

  /**
   * Set it up once, by itself, the first time the app starts with this feature in it.
   *
   * Only once: a setting records that we have done it, so deleting the agent means it stays
   * deleted rather than reappearing at every restart. "It runs itself at noon" is otherwise only
   * true if somebody remembers to call the setup endpoint by hand.
   */
  async ensureOnce(): Promise<void> {
    const done = await this.prisma.setting.findUnique({ where: { key: SETUP_KEY } }).catch(() => null);
    if (done?.value) return;
    try {
      const out = await this.ensure();
      await this.prisma.setting.upsert({
        where: { key: SETUP_KEY },
        create: { key: SETUP_KEY, value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      });
      this.log.log(`AI News Daily is set up (agent ${out.areaId}, flow ${out.flowId}) and runs at ${NEWS_SCHEDULE.at}`);
    } catch (e: any) {
      // Never take the app down over this. It stays un-set-up and will be tried again next boot.
      this.log.error(`could not set AI News Daily up: ${e?.message || e}`);
    }
  }

  private async savedIds(): Promise<{ areaId?: string; jobId?: string; flowId?: string }> {
    const row = await this.prisma.setting.findUnique({ where: { key: IDS_KEY } }).catch(() => null);
    try {
      return row?.value ? JSON.parse(row.value) : {};
    } catch {
      return {};
    }
  }

  private async remember(ids: { areaId: string; jobId: string; flowId: string }): Promise<void> {
    const value = JSON.stringify(ids);
    await this.prisma.setting
      .upsert({ where: { key: IDS_KEY }, create: { key: IDS_KEY, value }, update: { value } })
      .catch(() => undefined);
  }
}
