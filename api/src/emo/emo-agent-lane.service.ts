import { Injectable, Logger } from '@nestjs/common';
import { EmoCardsService } from './emo-cards.service';
import { AgentService } from '../agent/agent.service';
import { isJobBusy } from '../agent/run-lock.service';
import { HermesBridgeService } from '../hermes/hermes-bridge.service';
import { AgentAreasService } from '../agent/agent-areas.service';

/**
 * EMO agent lane (BEA-1086) — "run my morning brief" by voice. Never-guess rules: the spoken words
 * must single out exactly ONE saved agent; anything ambiguous becomes a needs-you card listing the
 * candidates instead of firing the wrong thing.
 */
@Injectable()
export class EmoAgentLaneService {
  private readonly log = new Logger('EmoAgentLane');

  constructor(
    private readonly cards: EmoCardsService,
    private readonly agent: AgentService,
    private readonly bridge: HermesBridgeService,
    private readonly areas?: AgentAreasService, // optional + LAST — spec files construct positionally
  ) {}

  private async listAreaNames(): Promise<{ id: string; name: string }[]> {
    try {
      const rows = (await this.areas?.list()) || [];
      return rows.map((r: any) => ({ id: r.id, name: r.name }));
    } catch { return []; }
  }

  /** Which saved agents do these words single out? */
  matchAgents(text: string, agents: { id: string; name: string; enabled?: boolean }[]): { id: string; name: string }[] {
    const t = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `;
    const hits = agents
      .filter((a) => a.enabled !== false && a.name)
      .filter((a) => {
        const words = a.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
        if (!words.length) return false;
        return words.every((w) => t.includes(` ${w}`) || t.includes(`${w} `) || t.includes(w));
      });
    return hits.map((a) => ({ id: a.id, name: a.name }));
  }

  async handle(cardId: string, answerText?: string) {
    const card: any = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'agent') return;
    const spoken = `${answerText || ''} ${card.rawTranscript || card.summary || ''}`.trim();
    const agents = (await this.agent.listAgents()) as any[]; // Agent rows ARE the jobs (BEA-1095)
    let hits = this.matchAgents(spoken, agents);

    // Areas-aware resolution (BEA-1107): "run my daily news" may name the AGENT, not a job.
    // Never-guess rule holds: a matched area only runs when it has exactly ONE enabled job.
    if (hits.length !== 1) {
      const byArea = new Map<string, { name: string; jobs: any[] }>();
      for (const a of agents) {
        if (a.enabled === false || !a.areaId) continue;
        if (!byArea.has(a.areaId)) byArea.set(a.areaId, { name: '', jobs: [] });
        byArea.get(a.areaId)!.jobs.push(a);
      }
      const areaRows = await this.listAreaNames();
      for (const ar of areaRows) if (byArea.has(ar.id)) byArea.get(ar.id)!.name = ar.name;
      const areaHits = [...byArea.values()].filter((g) => g.name && this.matchAgents(spoken, [{ id: 'x', name: g.name }] as any).length === 1);
      if (areaHits.length === 1) {
        const g = areaHits[0];
        if (g.jobs.length === 1) {
          hits = [{ id: g.jobs[0].id, name: g.jobs[0].name }];
        } else {
          await this.cards.update(cardId, {
            status: 'needs_you',
            needsQuestion: `Which job of ${g.name}? ${g.jobs.slice(0, 6).map((j) => j.name).join(' · ')}`,
          }).catch(() => undefined);
          return;
        }
      }
    }

    // Create-intent (BEA-1110): "create an agent to research X" / "make a research job on X" —
    // lands as a job inside the permanent Research Agent. "run it" in the words also runs it.
    const low = spoken.toLowerCase();
    const createIntent = /\b(create|make|start|new)\b/.test(low) && /\b(research|agent|job)\b/.test(low);
    if (hits.length !== 1 && createIntent && this.areas) {
      const runIt = /\brun it\b|\band run\b|\bthen run\b/.test(low);
      const subject = spoken
        .replace(/\b(please|create|make|start|new|an?|the|agent|job|to|that|which|for|about|on|research(es|ing)?|run it|and run|then run)\b/gi, ' ')
        .replace(/\s+/g, ' ').trim() || 'the topic you mentioned';
      try {
        const { id: areaId } = await this.areas.ensureResearchAgent();
        const job: any = await (this.agent as any).createAgent({
          areaId, name: `Research: ${subject.slice(0, 70)}`, icon: '🔬', autonomy: 'balanced',
          prompt: `1. Research this properly — read the best sources on the web: ${subject}.\n2. Write a clear plain-English report with sources at the end.\n3. Save the report as a document.`,
        });
        let runId: string | null = null;
        if (runIt) {
          const input = await this.bridge.applyAgentSkills(job, { prompt: job.prompt, title: job.name, agentId: job.id, depth: 'standard' });
          const run = await this.bridge.startRun(input);
          runId = run.id;
        }
        await this.cards.update(cardId, {
          status: 'done',
          summary: runIt ? `🔬 Created + running: ${job.name}` : `🔬 Created research job: ${job.name}`,
          detail: runIt ? 'It is researching now — the result lands in the job (Research Agent).' : 'It is waiting inside Research Agent — press Run when you are ready.',
          links: [{ kind: 'agent-job', id: job.id, label: job.name }, ...(runId ? [{ kind: 'agent-run', id: runId, label: 'live run' }] : [])],
        }).catch(() => undefined);
        this.log.log(`voice → created research job "${job.name}"${runIt ? ' + run' : ''}`);
        return;
      } catch (e: any) {
        this.log.warn(`voice create-research failed: ${e?.message}`);
      }
    }

    if (hits.length !== 1) {
      const names = agents.filter((a) => a.enabled !== false).slice(0, 6).map((a) => a.name).join(' · ');
      await this.cards.update(cardId, {
        status: 'needs_you',
        needsQuestion: hits.length === 0
          ? `Which agent should I run? You have: ${names || 'none yet'}`
          : `A few agents match — which one? ${hits.map((h) => h.name).join(' · ')}`,
      }).catch(() => undefined);
      return;
    }

    const a = agents.find((x) => x.id === hits[0].id)!;
    if (!a.prompt) {
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: `"${a.name}" has no task set yet — open it in Agents and give it one.` }).catch(() => undefined);
      return;
    }
    const depth = a.defaultDepth === 'quick' ? 'quick' : 'standard';
    const input = await this.bridge.applyAgentSkills(a, {
      prompt: `${a.prompt}\n\n[Spoken request] ${String(card.rawTranscript || '').slice(0, 800)}`,
      title: `${a.name} — by voice`,
      agentId: a.id,
      saveCollectionId: a.collectionId ?? null,
      rubric: a.rubric || undefined,
      depth,
    });
    // One run at a time per job (BEA-1388): a spoken "run it" while that job is already going says so
    // on the card instead of starting a second run — or dying quietly and leaving the card spinning.
    let run: any;
    try {
      run = await this.bridge.startRun({ ...input, lockReason: 'a run you started by voice' });
    } catch (e: any) {
      if (!isJobBusy(e)) throw e;
      await this.cards.update(cardId, { status: 'needs_you', summary: `⏳ ${a.name} is already running`, needsQuestion: e.message }).catch(() => undefined);
      return;
    }
    await this.cards.update(cardId, {
      status: 'done',
      summary: `▶ Started ${a.name}`,
      detail: `Your words: "${String(card.rawTranscript || '').slice(0, 300)}"\n\nThe result lands in the run (and your phone buzzes if it takes a while).`,
      links: [{ kind: 'agent-run', id: run.id, label: `${a.name} run` }],
    }).catch(() => undefined);
    this.log.log(`voice → started agent "${a.name}" (run ${run.id})`);
  }
}
