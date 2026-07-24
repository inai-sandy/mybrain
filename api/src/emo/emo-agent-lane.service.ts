import { Injectable, Logger } from '@nestjs/common';
import { EmoCardsService } from './emo-cards.service';
import { AgentService } from '../agent/agent.service';
import { HermesBridgeService } from '../hermes/hermes-bridge.service';

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
  ) {}

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
    const agents = (await this.agent.listAgents()) as any[];
    const hits = this.matchAgents(spoken, agents);

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
    const run = await this.bridge.startRun(input);
    await this.cards.update(cardId, {
      status: 'done',
      summary: `▶ Started ${a.name}`,
      detail: `Your words: "${String(card.rawTranscript || '').slice(0, 300)}"\n\nThe result lands in the run (and your phone buzzes if it takes a while).`,
      links: [{ kind: 'agent-run', id: run.id, label: `${a.name} run` }],
    }).catch(() => undefined);
    this.log.log(`voice → started agent "${a.name}" (run ${run.id})`);
  }
}
