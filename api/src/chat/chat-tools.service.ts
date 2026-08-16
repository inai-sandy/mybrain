import { Injectable, Logger } from '@nestjs/common';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { ToolCatalogService, CatalogTool } from '../tools/tool-catalog.service';
import { ServiceActionsService, ServiceCallContext } from '../tools/service-actions.service';
import { GatePause, PendingGate, ServiceGatesService } from '../tools/service-gates.service';

/**
 * Chat can use the services the owner has connected (BEA-1349). Design: `specs/TOOLS.md`.
 *
 * Chat already has the context — he is reading a document, thinking out loud — so "file that as a
 * Linear issue" should just happen. Everything underneath was already built: `ServiceActionsService`
 * runs one action with no engine turn (BEA-1347) and stops on the ones that cannot be undone
 * (BEA-1348). This file is only the join: pick the action, run it, and hand back either a chip or a
 * question.
 *
 * **The rule that matters most is the one about doing nothing.** When no outside service is
 * connected — which is how this server starts, and how a fresh instance stays — every method here
 * returns immediately with no model call, no prompt change and no error. Chat is the screen the
 * owner is on all day; a feature he has not set up may not cost him a single millisecond or a
 * single new failure mode.
 *
 * The other difference from an agent run is the gate. An agent pauses **durably** (BEA-795) because
 * nobody is watching; here the owner is sitting right in front of the thread, so the question is a
 * card in the conversation with two buttons, answered in seconds. Same decision, same recorded
 * `ServiceGate` row, same exact arguments re-run — just no waitpoint and no notification.
 */

/** What the reply shows for one call that really happened. */
export type ChatToolChip = {
  /** `svc:github.create_an_issue` */
  actionId: string;
  service: string;
  /** "GitHub" */
  serviceName: string;
  /** "Create an issue" */
  action: string;
  ok: boolean;
  /** A short readable line about what came back. */
  result?: string;
  /** The real reason, in plain English, when it failed. */
  error?: string;
  /** A link, when the service gave one. */
  link?: string;
  ms?: number;
};

/**
 * A gated action waiting for a tap. It carries the run/step pair on purpose: approvals are keyed on
 * `(runId, nodeId)`, so the confirm has to re-run with the very same pair or the yes is not found.
 */
export type ChatGateCard = PendingGate & {
  /** The two button labels, from the one place that owns them. */
  options: string[];
  runId: string;
  nodeId: string;
  /** What the step was given, kept so the re-run is the same step and not a new guess. */
  input: string;
  /** The question's own body — what it will run with, and on which account — for the card. */
  detail: string;
  /** Filled in once he has answered. */
  decision?: 'approved' | 'rejected';
  /**
   * When the answer was taken, written BEFORE anything runs.
   *
   * A double tap on "Yes, run it" — or a tap, a refresh and another tap — would otherwise be two
   * approvals and two calls, and this card only ever sits in front of something that cannot be
   * taken back.
   */
  claimedAt?: string;
};

/** What a turn's tool phase came to. `null` means "nothing to do" — by far the common case. */
export type ChatToolOutcome = {
  chips: ChatToolChip[];
  /** What the action returned, for the reply to be written from. Only ever set on a success. */
  note?: string;
  /** Set instead of `note` when this needs a tap before anything is sent. */
  gate?: ChatGateCard;
  /** Set instead of `note` when the call was really tried and really failed. The owner sees THIS. */
  failed?: string;
};

/**
 * How long "this is what he has connected" is reused for.
 *
 * Short enough that a service connected at /tools is usable in Chat almost straight away, long
 * enough that a run of messages does not ask the catalog once each.
 */
const KNOWN_MS = 60 * 1000;
/** How long a chat message will wait to find that out. Never more — he is typing. */
const LOOKUP_BUDGET_MS = 2500;
/** Ceilings on the two small picking calls. Choosing from a list is not a thinking job. */
const PICK_MAX_TOKENS = 120;
/** How much of the conversation the picker is shown. */
const CONVO_CHARS = 1200;
/** How many actions of the chosen service go into the second prompt. The catalog caps at 60. */
const MAX_ACTIONS = 60;
/** How much of an action's result is kept on the chip. */
const RESULT_CHARS = 300;
/** Keys worth putting on the chip's line, in the order a person would read them. */
const RESULT_KEYS = ['html_url', 'url', 'title', 'name', 'full_name', 'login', 'identifier', 'key', 'number', 'id', 'state', 'status', 'text', 'message'];

@Injectable()
export class ChatToolsService {
  private readonly log = new Logger('ChatTools');

  constructor(
    // Every one of these is optional and LAST — spec harnesses build the chat side positionally,
    // and a missing piece here must mean "no tools", never a crash on a normal message.
    private readonly llm?: LlmService,
    private readonly prompts?: PromptsService,
    private readonly catalog?: ToolCatalogService,
    private readonly actions?: ServiceActionsService,
    private readonly gates?: ServiceGatesService,
  ) {}

  /** The last answer about what is connected, so a burst of messages asks once. */
  private known: { at: number; tools: CatalogTool[] } | null = null;

  /**
   * Is anything connected at all? The cheapest possible question, and the one that keeps the
   * promise that an owner with nothing connected sees no change whatsoever.
   *
   * It is answered from a short-lived memory, and it is on a stopwatch. The catalog is allowed to
   * take its time — an outside service can be slow, and with a key set but nothing connected yet it
   * really does go and ask — but a chat message is not allowed to wait for it. Past the budget the
   * turn carries on with the last known answer, which on a fresh server is "nothing", and the
   * catalog's own cache is warm for the next message.
   */
  async available(): Promise<CatalogTool[]> {
    if (!this.catalog?.connectedServiceTools || !this.actions?.run) return [];
    if (this.known && Date.now() - this.known.at < KNOWN_MS) return this.known.tools;

    const budget = new Promise<null>((r) => setTimeout(() => r(null), LOOKUP_BUDGET_MS).unref?.());
    const fresh = await Promise.race([this.catalog.connectedServiceTools().catch(() => [] as CatalogTool[]), budget]);
    if (!fresh) return this.known?.tools || [];
    this.known = { at: Date.now(), tools: fresh };
    return fresh;
  }

  /**
   * The tool phase of one chat turn: decide, then do.
   *
   * Returns `null` when there is nothing to do — nothing connected, or the message was just a
   * message. The caller then carries on exactly as it always has.
   */
  async maybeRun(input: {
    text: string;
    recent: { role: string; content: string }[];
    /** Asked for only once there is something to pick from — nothing connected must cost nothing. */
    model: () => Promise<LlmConfig | null>;
    runId: string;
    nodeId: string;
    onNote?: (note: string) => void;
  }): Promise<ChatToolOutcome | null> {
    const entries = await this.available();
    if (!entries.length) return null;

    const actionId = await this.pick(input.text, input.recent, entries, await input.model()).catch((e) => {
      this.log.warn(`could not pick a tool: ${e?.message || e}`);
      return null;
    });
    if (!actionId) return null;

    const entry = entries.find((t) => t.id === actionId)!;
    input.onNote?.(`Using ${entry.name}…`);
    return this.execute(entry, input.text, { runId: input.runId, nodeId: input.nodeId, runKind: 'chat', label: 'Chat' });
  }

  /**
   * Run one action and turn every ending into something the thread can show honestly.
   *
   * `ServiceActionsService.run()` throws on every road but a real success — that is deliberate, so
   * nothing can quietly become a fluent description of a deletion that never happened. Here the
   * throw becomes either the confirm card (a `GatePause`) or the failure line the owner reads.
   */
  private async execute(entry: CatalogTool, text: string, ctx: ServiceCallContext & { runId: string; nodeId: string }): Promise<ChatToolOutcome> {
    const { serviceName, action } = this.split(entry);
    const base = { actionId: entry.id, service: entry.service || '', serviceName, action };
    const started = Date.now();
    try {
      const note = await this.actions!.run(entry.id, text, ctx);
      return { chips: [{ ...base, ok: true, result: this.resultLine(note), link: this.linkIn(note), ms: Date.now() - started }], note };
    } catch (e: any) {
      if (e instanceof GatePause || e?.name === 'GatePause') {
        const gate: PendingGate = e.gate;
        return {
          chips: [],
          gate: {
            ...gate,
            options: this.gates?.options || ['Yes, run it', 'No, stop'],
            runId: ctx.runId,
            nodeId: ctx.nodeId,
            input: text,
            detail: this.detailOf(gate),
          },
        };
      }
      // The message is already plain English and already names the real reason — it is written for
      // the owner by the service that failed. It is passed through untouched, never softened.
      const failed = String(e?.message || e);
      return { chips: [{ ...base, ok: false, error: failed, ms: Date.now() - started }], failed };
    }
  }

  /**
   * He answered the confirm card.
   *
   * A no records the refusal and runs nothing. A yes records the approval and then runs the step
   * again with the SAME run/step pair, which is how `ServiceActionsService` finds the approval and
   * re-uses the exact arguments he was shown. The arguments are never filled again — otherwise he
   * would approve one repository and watch another one go.
   */
  async answerGate(gate: ChatGateCard, answer: string): Promise<{ approved: boolean; message: string; outcome?: ChatToolOutcome }> {
    if (!this.actions?.answerGate) return { approved: false, message: 'Outside services are not available on this server.' };
    const ctx: ServiceCallContext = { runId: gate.runId, nodeId: gate.nodeId, runKind: 'chat', label: 'Chat' };
    const said = await this.actions.answerGate(gate, answer, ctx);
    if (!said.approved) return { approved: false, message: said.message };

    const entry: CatalogTool = {
      id: gate.actionId,
      name: `${gate.serviceName}: ${gate.actionName}`,
      group: 'Services',
      kind: 'tool',
      connected: true,
      description: '',
      service: gate.service,
    };
    return { approved: true, message: said.message, outcome: await this.execute(entry, gate.input || '', { ...ctx, runId: gate.runId, nodeId: gate.nodeId }) };
  }

  /**
   * The middle of the gate's own question — what it will run with, on which account, and why.
   *
   * The question is built in one place for every surface (`ServiceGatesService.build`), so it is
   * reused rather than rewritten here. Two lines of it are dropped: the headline, which the card
   * already shows as its title, and the closing "say yes / say no", which describes an unattended
   * run carrying on — not a card with two buttons an inch below it.
   */
  private detailOf(gate: PendingGate): string {
    return String(gate.question || '')
      .split('\n')
      .slice(1)
      .filter((l) => !/^say yes/i.test(l.trim()))
      .join('\n')
      .trim();
  }

  // ---- picking ---------------------------------------------------------------------------------

  /**
   * Which action, if any — in two small steps rather than one big one.
   *
   * A single prompt would have to carry every action of every connected service (GitHub alone puts
   * 36 in the catalog), on every message the owner types, just to answer "no" nearly every time. So
   * the first call is shown only the service NAMES and costs a couple of hundred tokens; the second,
   * which only happens once he really is asking for something to be done, is shown one service's
   * actions.
   */
  private async pick(text: string, recent: { role: string; content: string }[], entries: CatalogTool[], model: LlmConfig | null): Promise<string | null> {
    const services = new Map<string, string>();
    for (const t of entries) if (t.service && !services.has(t.service)) services.set(t.service, this.split(t).serviceName);
    if (!services.size) return null;

    const policy = (await this.prompts?.get?.('chat.tools').catch(() => '')) || FALLBACK_POLICY;
    const convo = recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n').slice(-CONVO_CHARS);

    const slug = await this.ask(model, [
      policy,
      '',
      'The services he has connected:',
      ...[...services].map(([s, name]) => `- ${s} — ${name}`),
      '',
      convo ? `Conversation so far:\n${convo}\n` : '',
      `New message: ${text}`,
      '',
      'Reply with ONLY JSON: {"service": "<slug from the list>"} or {"service": null} if this is not a job for any of them.',
    ], 'service');
    // Never take a name that was not offered — a made-up slug is how a chat would try to act on a
    // service the owner never connected.
    if (!slug || !services.has(slug)) return null;

    const mine = entries.filter((t) => t.service === slug).slice(0, MAX_ACTIONS);
    if (!mine.length) return null;

    const actionId = await this.ask(model, [
      policy,
      '',
      `He is asking for something to be done with ${services.get(slug)}. Pick the ONE action that does it.`,
      '',
      'Actions:',
      ...mine.map((t) => `- ${t.id} — ${this.split(t).action}${t.description ? `: ${t.description}` : ''}`),
      '',
      convo ? `Conversation so far:\n${convo}\n` : '',
      `New message: ${text}`,
      '',
      'Reply with ONLY JSON: {"action": "<id from the list>"} or {"action": null} if none of them is what he asked for.',
    ], 'action');
    // Same rule again: only an id that is really in his catalog. Anything else is a guess.
    return actionId && mine.some((t) => t.id === actionId) ? actionId : null;
  }

  /** One small JSON question. A null, a blank or anything unreadable all mean "no tool". */
  private async ask(model: LlmConfig | null, lines: string[], key: 'service' | 'action'): Promise<string | null> {
    if (!this.llm?.completeWith) return null;
    const raw = await this.llm.completeWith(model, lines.filter((l) => l !== '').join('\n'), PICK_MAX_TOKENS, `chat-tools-${key}`).catch(() => null);
    if (!raw) return null;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const v = JSON.parse(raw.slice(start, end + 1))?.[key];
      const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
      return s && s !== 'null' && s !== 'none' ? s : null;
    } catch {
      return null;
    }
  }

  // ---- reading what came back ------------------------------------------------------------------

  /** "GitHub: Create an issue" → the two halves the chip shows. */
  private split(t: CatalogTool): { serviceName: string; action: string } {
    const i = (t.name || '').indexOf(': ');
    if (i > 0) return { serviceName: t.name.slice(0, i), action: t.name.slice(i + 2) };
    return { serviceName: t.service || 'Service', action: t.name || 'action' };
  }

  /**
   * One readable line about what came back, for under the chip.
   *
   * The payload itself is whatever the service returns — often a big JSON object. The few keys a
   * person actually looks for are pulled out of it; anything else falls back to the first of the
   * text, which is still the truth and still short.
   */
  private resultLine(note: string): string {
    const body = String(note || '').split('What came back:').pop() || '';
    const data = this.parseJson(body);
    if (data) {
      const bits: string[] = [];
      for (const k of RESULT_KEYS) {
        const v = data[k];
        if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
        bits.push(`${k.replace(/_/g, ' ')}: ${String(v).slice(0, 120)}`);
        if (bits.length === 3) break;
      }
      if (bits.length) return bits.join(' · ').slice(0, RESULT_CHARS);
    }
    const flat = body.replace(/\s+/g, ' ').trim();
    return (flat || 'Done.').slice(0, RESULT_CHARS);
  }

  /** A link, only when the service really gave one. */
  private linkIn(note: string): string | undefined {
    const m = String(note || '').match(/https?:\/\/[^\s"'\\)]+/);
    return m?.[0]?.replace(/[.,)]+$/, '') || undefined;
  }

  private parseJson(text: string): Record<string, any> | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
      // Composio wraps the provider's own answer; the useful half is usually one level down.
      const inner = v.data && typeof v.data === 'object' && !Array.isArray(v.data) ? v.data : null;
      return inner || v;
    } catch {
      return null;
    }
  }
}

/** Used only if the prompt registry is not available (a partial spec harness). Same words. */
const FALLBACK_POLICY =
  'Decide whether the new message is asking for something to be DONE in one of the connected services, rather than a question to answer. ' +
  'Pick one only when he is plainly asking for that action, or for something to be looked up there, right now.';
