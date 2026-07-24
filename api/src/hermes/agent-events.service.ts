import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { HermesBridgeService } from './hermes-bridge.service';
import { AppEventsService, AppEventName, AppEventPayload } from '../events/events.service';

const EVENTS: AppEventName[] = ['journal.added', 'whatsapp.reply', 'bookmark.added'];

/**
 * Event triggers (BEA-1076): agents whose schedule is {event: "<name>"} fire the moment that thing
 * happens — a journal entry lands, a contact replies on WhatsApp, a bookmark arrives — with the
 * event's summary as part of the run's input (so Replay re-runs on the same trigger data).
 */
@Injectable()
export class AgentEvents implements OnModuleInit {
  private readonly log = new Logger('AgentEvents');

  constructor(
    private readonly agent: AgentService,
    private readonly bridge: HermesBridgeService,
    private readonly events: AppEventsService,
  ) {}

  onModuleInit() {
    for (const name of EVENTS) {
      this.events.on(name, (payload) => void this.fire(name, payload).catch((e) => this.log.warn(`fire ${name}: ${e?.message}`)));
    }
  }

  async fire(name: AppEventName, payload: AppEventPayload) {
    const agents = (await this.agent.listAgents()) as any[];
    const hit = agents.filter((a) => a.enabled && a.prompt && a.schedule && (a.schedule as any).event === name);
    for (const a of hit) {
      this.log.log(`event ${name} → firing agent "${a.name}"`);
      await this.bridge.startRun(await this.bridge.applyAgentSkills(a, {
        prompt: `${a.prompt}\n\n[Trigger] ${payload.summary}`,
        title: `${a.name} — ${EVENT_LABEL[name] || name}`,
        agentId: a.id,
        rubric: a.rubric || undefined,
        saveCollectionId: a.collectionId ?? null,
        depth: a.defaultDepth === 'quick' ? 'quick' : 'standard',
      })).catch((e) => this.log.warn(`event run for ${a.name} failed to start: ${e?.message}`));
    }
  }
}

const EVENT_LABEL: Record<string, string> = {
  'journal.added': 'new journal entry',
  'whatsapp.reply': 'WhatsApp reply',
  'bookmark.added': 'new bookmark',
};
