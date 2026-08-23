import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BuilderSampleService, SampleView } from './builder-sample.service';
import {
  AI_LINES_MAX,
  Brief,
  BriefDelivery,
  BriefLine,
  BriefRefusal,
  BriefSource,
  LineOrigin,
  SECTION_KEYS,
  SectionKey,
  TranscriptTurn,
  emptyDelivery,
  emptySections,
  forCodexPayload,
  isSectionKey,
  line,
  lineId,
  readDelivery,
  readSections,
  readSources,
  readTools,
  readTranscript,
  roomForAnotherLine,
  sourceName,
  whyNotApprovable,
} from './brief';

/**
 * The builder has filled the brief and must ask him something instead (BEA-1416). Its own error
 * type, so the turn engine can hand the sentence back to the model rather than showing him a crash.
 */
export class BriefFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BriefFullError';
  }
}

/**
 * The brief's store, and the four rules that decide whether one may be approved (BEA-1405).
 *
 * The rules live HERE, in code, not in the builder's prompt. A prompt is a request, and the builder
 * has already shown — four times in one conversation — that it will talk its way past a request. A
 * refusal from this service is the only thing that actually stops a half-finished brief becoming an
 * agent.
 *
 * `look()` is the other half: the builder may not write "Gmail will give you your important mail"
 * as a fact. It has to CALL Gmail, and what it writes down carries the `ToolCall` row that proves
 * it. That call goes through `BuilderSampleService`, so the existing caps (3 calls, 5 credits per
 * conversation) and the existing read-only refusals apply unchanged — a builder still cannot send,
 * delete or gate anything.
 *
 * Optional deps LAST and `?.`-guarded: several spec harnesses build services positionally.
 */
/**
 * A line has to carry at least this many characters before striking it also marks the turns of the
 * conversation that contain those words. "No" appears in half a transcript; a real proposal does not.
 */
export const STRIKE_MATCH_MIN = 12;

@Injectable()
export class BriefService {
  private readonly log = new Logger('Brief');

  constructor(
    private prisma: PrismaService,
    private sampler?: BuilderSampleService,
  ) {}

  // ---- reading -----------------------------------------------------------------------------------

  private shape(row: any): Brief {
    return {
      id: String(row.id),
      areaId: String(row.areaId),
      version: Number(row.version) || 1,
      status: row.status === 'approved' ? 'approved' : 'draft',
      name: String(row.name || ''),
      sections: readSections(this.json(row.sections)),
      sources: readSources(this.json(row.sources)),
      tools: readTools(this.json(row.tools)),
      schedule: this.json(row.schedule) || null,
      delivery: readDelivery(this.json(row.delivery)),
      transcript: readTranscript(this.json(row.transcript)),
      approvedAt: row.approvedAt ? new Date(row.approvedAt).toISOString() : null,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : undefined,
    };
  }

  private json(v: any): any {
    if (v && typeof v === 'object') return v;
    try {
      return JSON.parse(String(v || 'null'));
    } catch {
      return null;
    }
  }

  /** The newest brief for an agent, whatever its state. Null when there is none yet. */
  async latest(areaId: string): Promise<Brief | null> {
    const row = await this.prisma?.agentBrief?.findFirst?.({ where: { areaId: String(areaId) }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] });
    return row ? this.shape(row) : null;
  }

  async get(id: string): Promise<Brief | null> {
    const row = await this.prisma?.agentBrief?.findUnique?.({ where: { id: String(id) } });
    return row ? this.shape(row) : null;
  }

  /** The newest APPROVED brief — what a build is allowed to be made from. */
  async approved(areaId: string): Promise<Brief | null> {
    const row = await this.prisma?.agentBrief?.findFirst?.({ where: { areaId: String(areaId), status: 'approved' }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] });
    return row ? this.shape(row) : null;
  }

  // ---- writing -----------------------------------------------------------------------------------

  /**
   * The working draft. There is at most ONE draft per agent: a second call returns the same row, so
   * a reloaded page or a second turn of the conversation cannot fork the brief in two.
   */
  async draft(areaId: string, name = ''): Promise<Brief> {
    // An agent that is gone gets no new brief. Without this, asking for the brief of a deleted agent
    // quietly makes one — found while proving the delete sweep works, which is exactly the kind of
    // orphan that sweep exists to prevent.
    const area = await this.prisma?.agentArea?.findUnique?.({ where: { id: String(areaId) }, select: { id: true } });
    if (area === null) throw new Error('That agent is gone.');
    const open = await this.prisma?.agentBrief?.findFirst?.({ where: { areaId: String(areaId), status: 'draft' }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] });
    if (open) return this.shape(open);
    const last = await this.latest(areaId);
    const row = await this.prisma.agentBrief.create({
      data: {
        areaId: String(areaId),
        version: (last?.version || 0) + 1,
        status: 'draft',
        name: String(name || last?.name || ''),
        // A new version starts from the last approved one — he edits, he does not retype.
        sections: JSON.stringify(last?.sections || emptySections()),
        sources: JSON.stringify(last?.sources || []),
        tools: JSON.stringify(last?.tools || []),
        schedule: last?.schedule ? JSON.stringify(last.schedule) : null,
        delivery: JSON.stringify(last?.delivery || emptyDelivery()),
        transcript: JSON.stringify(last?.transcript || []),
      },
    });
    return this.shape(row);
  }

  private async save(id: string, patch: Record<string, any>): Promise<Brief> {
    const row = await this.prisma.agentBrief.update({ where: { id: String(id) }, data: patch });
    return this.shape(row);
  }

  /**
   * Replace what the conversation has worked out so far. An approved brief is never edited in
   * place — editing one starts the next version, so a worker built from version 2 can always say
   * what version 2 said.
   */
  async update(id: string, patch: { name?: string; sections?: any; sources?: any; tools?: any; schedule?: any; delivery?: any; transcript?: any }): Promise<Brief> {
    const current = await this.get(id);
    if (!current) throw new Error('That brief is gone.');
    const target = current.status === 'approved' ? await this.draft(current.areaId, current.name) : current;
    const data: Record<string, any> = {};
    if (patch.name !== undefined) data.name = String(patch.name || '');
    if (patch.sections !== undefined) data.sections = JSON.stringify(readSections(patch.sections));
    if (patch.sources !== undefined) data.sources = JSON.stringify(readSources(patch.sources));
    if (patch.tools !== undefined) data.tools = JSON.stringify(readTools(patch.tools));
    if (patch.schedule !== undefined) data.schedule = patch.schedule ? JSON.stringify(patch.schedule) : null;
    if (patch.delivery !== undefined) data.delivery = JSON.stringify(readDelivery(patch.delivery));
    if (patch.transcript !== undefined) data.transcript = JSON.stringify(readTranscript(patch.transcript));
    return this.save(target.id, data);
  }

  /**
   * Add one line to a section, tagged with where it came from.
   *
   * The AI runs out of room at `AI_LINES_MAX` (BEA-1416); he never does. A brief he will not read is
   * a rubber stamp, and the builder's way out of a full brief is to ask him a question — not to write
   * one more line into a document he is already scrolling past.
   */
  async addLine(id: string, section: SectionKey, text: string, origin: LineOrigin, evidence?: BriefLine['evidence']): Promise<Brief> {
    const b = await this.get(id);
    if (!b) throw new Error('That brief is gone.');
    if (!isSectionKey(section)) throw new Error('There is no such part of a brief.');
    if (origin === 'ai') {
      const room = roomForAnotherLine(b.sections);
      if (!room.ok) throw new BriefFullError(room.why!);
    }
    const target = b.status === 'approved' ? await this.draft(b.areaId, b.name) : b;
    const sections = target.sections;
    sections[section] = [...(sections[section] || []), line(text, origin, evidence ? { evidence } : {})];
    return this.save(target.id, { sections: JSON.stringify(sections) });
  }

  /**
   * Edit a line. An edited line becomes HIS — the moment he touches it, it stops being the AI's
   * guess, and the screen stops marking it as one.
   */
  async editLine(id: string, lineIdToEdit: string, text: string): Promise<Brief> {
    const b = await this.get(id);
    if (!b) throw new Error('That brief is gone.');
    const target = b.status === 'approved' ? await this.draft(b.areaId, b.name) : b;
    const sections = target.sections;
    let found = false;
    for (const k of SECTION_KEYS) {
      sections[k] = (sections[k] || []).map((l) => {
        if (l.id !== lineIdToEdit) return l;
        found = true;
        // The evidence goes with it: his sentence is not what the tool said.
        const { evidence, ...rest } = l;
        return { ...rest, text: String(text || '').trim(), origin: 'owner' as LineOrigin };
      });
    }
    if (!found) throw new Error('That line is not in this brief any more.');
    return this.save(target.id, { sections: JSON.stringify(sections) });
  }

  /**
   * Kill a line — or bring it back. It is MARKED, never deleted, and it also moves into `killed` so
   * the screen can show him what he threw away and so nothing downstream can quietly rebuild it.
   * A struck line's turn in the transcript is marked too, because the transcript is what Codex reads.
   */
  async strike(id: string, lineIdToStrike: string, struck = true): Promise<Brief> {
    const b = await this.get(id);
    if (!b) throw new Error('That brief is gone.');
    const target = b.status === 'approved' ? await this.draft(b.areaId, b.name) : b;
    const sections = target.sections;
    let hit: BriefLine | null = null;
    for (const k of SECTION_KEYS) {
      sections[k] = (sections[k] || []).map((l) => {
        if (l.id !== lineIdToStrike) return l;
        hit = { ...l, struck: !!struck };
        return hit as BriefLine;
      });
    }
    if (!hit) {
      // It may already be sitting in `killed` — un-striking brings it back to life there.
      sections.killed = (sections.killed || []).map((l) => {
        if (l.id !== lineIdToStrike) return l;
        hit = { ...l, struck: !!struck };
        return hit as BriefLine;
      });
    }
    if (!hit) throw new Error('That line is not in this brief any more.');
    const killed = (sections.killed || []).filter((l) => l.id !== lineIdToStrike);
    sections.killed = struck ? [...killed, hit] : killed;

    // The same words in the transcript get the same mark, so Codex sees the decision and not just
    // the idea. ONLY the turns that really carry those words move — a short line like "No" must not
    // mark the whole conversation, and bringing one line back must not un-kill every other one.
    const text = String((hit as BriefLine).text || '').trim();
    const marks = text.length >= STRIKE_MATCH_MIN;
    const transcript = target.transcript.map((t) => {
      if (!marks || !t.text.includes(text)) return t;
      const { struck: was, ...rest } = t;
      return struck ? { ...rest, struck: true } : rest;
    });

    return this.save(target.id, { sections: JSON.stringify(sections), transcript: JSON.stringify(readTranscript(transcript)) });
  }

  // ---- looking before planning ---------------------------------------------------------------------

  /**
   * Call a tool for real and write down what it actually showed.
   *
   * This is rule one. The builder that cost the owner nine hours planned a Gmail agent without ever
   * calling Gmail — in thirty turns it ran exactly one look, at the wrong thing. What it wrote about
   * Gmail was invention, printed in the same colour as his own instructions.
   *
   * The returned line is tagged `tool` and carries the `ToolCall` row, so it can prove itself.
   */
  async look(sessionKey: string, actionId: string, args: Record<string, any> = {}): Promise<{ view: SampleView; saw: string; evidence?: BriefLine['evidence'] }> {
    if (!this.sampler) return { view: refusedView(actionId, 'I cannot look at anything from here.'), saw: '' };
    const view = await this.sampler.sample(sessionKey, actionId, args);
    const saw = sawText(view);
    const evidence = view.ok && view.callId ? { callId: view.callId, ...(view.sampleId ? { sampleId: view.sampleId } : {}), actionId: String(actionId) } : undefined;
    return { view, saw, evidence };
  }

  /** Record a look against a source, so `approve()` can see the source has really been opened. */
  async noteSource(id: string, source: BriefSource): Promise<Brief> {
    const b = await this.get(id);
    if (!b) throw new Error('That brief is gone.');
    const target = b.status === 'approved' ? await this.draft(b.areaId, b.name) : b;
    const sources = target.sources.filter((s) => s.id !== source.id);
    const next = [...sources, source];
    const sections = target.sections;
    if (source.saw) {
      const already = (sections.sources || []).some((l) => l.text === source.saw);
      if (!already) sections.sources = [...(sections.sources || []), line(source.saw, 'tool', source.evidence ? { evidence: source.evidence } : {})];
    }
    return this.save(target.id, { sources: JSON.stringify(next), sections: JSON.stringify(sections) });
  }

  // ---- approving -----------------------------------------------------------------------------------

  /**
   * The gate. Refusals come back in plain English, each naming the part of the brief it belongs to,
   * so the screen can show the reason beside the thing that is missing rather than in a toast that
   * vanishes.
   */
  async whyNot(id: string): Promise<BriefRefusal[]> {
    const b = await this.get(id);
    if (!b) return [{ section: 'want', why: 'That brief is gone.' }];
    return whyNotApprovable(b, await this.knownCallIds(b.sources));
  }

  /** Which of the claimed proofs are real rows. A made-up id proves nothing. */
  private async knownCallIds(sources: BriefSource[]): Promise<Set<string>> {
    const ids = (sources || []).map((s) => s.evidence?.callId).filter(Boolean) as string[];
    if (!ids.length) return new Set();
    const rows = (await this.prisma?.toolCall?.findMany?.({ where: { id: { in: ids } }, select: { id: true } })) || [];
    return new Set(rows.map((r: any) => String(r.id)));
  }

  async approve(id: string): Promise<{ ok: boolean; brief?: Brief; refusals?: BriefRefusal[] }> {
    const b = await this.get(id);
    if (!b) return { ok: false, refusals: [{ section: 'want', why: 'That brief is gone.' }] };
    const refusals = whyNotApprovable(b, await this.knownCallIds(b.sources));
    if (refusals.length) return { ok: false, refusals };
    const saved = await this.save(b.id, { status: 'approved', approvedAt: new Date() });
    return { ok: true, brief: saved };
  }

  /**
   * The proof behind a `tool` line: the call it leans on, as it was written down at the time.
   * Tapping the line opens this — so "I looked and Gmail gave me 47 emails" is checkable in one tap
   * instead of taken on trust. Arguments are already masked in the row; nothing new is exposed.
   */
  async proof(callId: string): Promise<{ ok: boolean; actionId?: string; args?: any; result?: string; error?: string; credits?: number; ms?: number; at?: string } | null> {
    const row = await this.prisma?.toolCall?.findUnique?.({ where: { id: String(callId) } });
    if (!row) return null;
    let args: any = null;
    try { args = row.arguments ? JSON.parse(String(row.arguments)) : null; } catch { args = row.arguments || null; }
    return {
      ok: !!row.ok,
      actionId: String(row.action || ''),
      args,
      result: row.result ? String(row.result) : undefined,
      error: row.error ? String(row.error) : undefined,
      credits: row.credits === null || row.credits === undefined ? undefined : Number(row.credits),
      ms: row.ms === null || row.ms === undefined ? undefined : Number(row.ms),
      at: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
    };
  }

  // ---- handing it on ---------------------------------------------------------------------------------

  /** What a build turn is given: the brief on top, the whole conversation under it (BEA-1407). */
  async forCodex(areaId: string): Promise<ReturnType<typeof forCodexPayload> | null> {
    const b = await this.approved(areaId);
    return b ? forCodexPayload(b) : null;
  }

  /** Append turns of the conversation. Nothing is ever summarised on the way in. */
  async addTurns(id: string, turns: { who: 'you' | 'ai'; text: string; at?: string; kind?: string }[]): Promise<Brief> {
    const b = await this.get(id);
    if (!b) throw new Error('That brief is gone.');
    const target = b.status === 'approved' ? await this.draft(b.areaId, b.name) : b;
    const add: TranscriptTurn[] = (turns || []).map((t) => ({ id: lineId('t'), who: t.who === 'you' ? 'you' : 'ai', text: String(t.text || ''), at: String(t.at || new Date().toISOString()), ...(t.kind ? { kind: String(t.kind) } : {}) }));
    return this.save(target.id, { transcript: JSON.stringify([...target.transcript, ...add]) });
  }
}

/** One plain sentence about what a look really showed — what a `tool` line says. */
export function sawText(view: SampleView): string {
  if (!view) return '';
  if (view.refused) return '';
  if (!view.ok) return `I tried ${view.name} and it did not work: ${view.error || 'no reason given'}.`;
  const noun = view.count === 1 ? 'thing' : 'things';
  const fields = (view.fields || []).slice(0, 6).map((f) => f.path).join(', ');
  const date = view.hasDate ? '' : ' It has no date on it, so "the last few days" cannot be judged from it.';
  return `I looked at ${view.name} and got ${view.count} ${noun}${fields ? `, each with ${fields}` : ''}.${date}`;
}

function refusedView(actionId: string, why: string): SampleView {
  return { ok: false, actionId, name: sourceName({ id: '', actionId, args: {} }), args: {}, count: 0, fields: [], hasDate: false, items: [], credits: 0, ms: 0, error: why, refused: true, budget: { used: 0, calls: 0, credits: 0, maxCredits: 0 } };
}

export type { Brief, BriefDelivery, BriefRefusal, BriefSource };
