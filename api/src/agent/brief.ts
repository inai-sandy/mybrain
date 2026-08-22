/**
 * The brief (BEA-1405, "Brief First") — what replaces the eight-box form as the thing an agent is
 * made from.
 *
 * ## Why this exists
 *
 * `AgentPlan` (`social/plan.ts`) has eight boxes: sources · creators · merge · shape · watch ·
 * output · notify · schedule. `notify` is two booleans with **no message text in it**, so
 * "WhatsApp me a summary grouped into work, personal and finance" could not be expressed at all —
 * the agent could only ever send "finished · N rows". The builder promised the owner that format in
 * the chat, the form silently dropped it, nobody compared the two, and he found out weeks later.
 * The same hole swallowed "read all my emails" (no box for how many), and it swallows anything that
 * is not the one fixed line fetch → merge → shape → save → notify.
 *
 * A bigger form would only move the walls. A brief is **language with named parts**, so it can hold
 * a job neither of us has thought of yet.
 *
 * ## The three tags, and why they are the point
 *
 * Every line says where it came from:
 *  - `owner` — his own words, quoted, never reworded.
 *  - `tool`  — something a real call actually showed, carrying the `ToolCall` row that proves it.
 *  - `ai`    — the builder's own suggestion.
 *
 * On the night this was written, the AI's invention and his instruction were printed in the same
 * colour, in the same paragraph, and he had no way to tell them apart. That is the bug this file is
 * mostly about.
 *
 * ## Evidence is a `ToolCall`, not a `ToolSample`
 *
 * The obvious anchor for "I looked" is the saved answer (`ToolSample`, BEA-1386) — but Gmail,
 * WhatsApp, Slack and every other message-carrying service are in `NO_SAMPLE_SERVICES` **on
 * purpose**, so their answers are deliberately never kept. Requiring a sample would make it
 * impossible to write an honest, evidenced brief for exactly the agent that started all this. The
 * `ToolCall` row is always written, so that is the proof; a `sampleId` rides along when there is
 * one.
 *
 * Pure. No Nest, no Prisma — the service does the storing.
 */

// ---- lines -------------------------------------------------------------------------------------

export type LineOrigin = 'owner' | 'tool' | 'ai';

/** What one call proved. `callId` is a `ToolCall` row; `sampleId` a whole saved answer, if kept. */
export type LineEvidence = { callId: string; sampleId?: string; actionId?: string };

export type BriefLine = {
  id: string;
  text: string;
  origin: LineOrigin;
  /** Killed by the owner. Kept, marked, never deleted — so nothing downstream can rebuild it. */
  struck?: boolean;
  evidence?: LineEvidence;
  at?: string;
};

// ---- sections ----------------------------------------------------------------------------------

export type SectionKey = 'want' | 'sources' | 'filter' | 'output' | 'when' | 'success' | 'trouble';

export const SECTION_KEYS: SectionKey[] = ['want', 'sources', 'filter', 'output', 'when', 'success', 'trouble'];

/** The owner reads these headings. Plain words, his words where possible. */
export const SECTION_LABELS: Record<SectionKey, string> = {
  want: 'What I want',
  sources: 'Where it comes from',
  filter: 'What counts, what to ignore',
  output: 'What to do with it',
  when: 'When it runs',
  success: 'What "it worked" means',
  trouble: 'If something goes wrong',
};

export type BriefSections = Record<SectionKey, BriefLine[]> & { killed: BriefLine[] };

/** One source the brief names, with the look that proves somebody actually opened it. */
export type BriefSource = {
  id: string;
  actionId: string;
  args: Record<string, any>;
  /** The look. Absent means nobody has called this action in this conversation — approve refuses. */
  evidence?: LineEvidence;
  /** What the look showed, in one plain sentence, for the screen. */
  saw?: string;
};

/**
 * Where the result goes. `messageText` is the whole point of the redesign: the exact words that
 * will arrive on his phone, written down before anything is built, instead of a boolean that could
 * only ever mean "finished · N rows".
 */
export type BriefDelivery = {
  whatsapp: boolean;
  telegram: boolean;
  messageText: string;
};

export type TranscriptTurn = {
  id: string;
  who: 'you' | 'ai';
  text: string;
  at: string;
  /** 'sample' for a 🔎 look line, 'seed' for the Social hand-off — as the builder log already tags. */
  kind?: string;
  /** The owner killed what this turn proposed. Marked, never removed. */
  struck?: boolean;
};

export type Brief = {
  id: string;
  areaId: string;
  version: number;
  status: 'draft' | 'approved';
  name: string;
  sections: BriefSections;
  sources: BriefSource[];
  delivery: BriefDelivery;
  transcript: TranscriptTurn[];
  approvedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

// ---- building blocks ---------------------------------------------------------------------------

let seq = 0;
/** Ids only have to be unique inside one brief; a counter beside the clock is enough and testable. */
export function lineId(prefix = 'l'): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

export function emptySections(): BriefSections {
  const out: any = { killed: [] };
  for (const k of SECTION_KEYS) out[k] = [];
  return out as BriefSections;
}

export function emptyDelivery(): BriefDelivery {
  return { whatsapp: false, telegram: false, messageText: '' };
}

export function line(text: string, origin: LineOrigin, extra: Partial<BriefLine> = {}): BriefLine {
  return { id: extra.id || lineId(), text: String(text || '').trim(), origin, ...(extra.evidence ? { evidence: extra.evidence } : {}), ...(extra.struck ? { struck: true } : {}), ...(extra.at ? { at: extra.at } : {}) };
}

/** Lines that still count — a struck line is present but does not speak. */
export function live(lines: BriefLine[] | undefined): BriefLine[] {
  return (lines || []).filter((l) => l && !l.struck && String(l.text || '').trim());
}

export function isSectionKey(k: any): k is SectionKey {
  return SECTION_KEYS.includes(k as SectionKey);
}

/** Read whatever came out of the database into a shape the rest of this file can trust. */
export function readSections(raw: any): BriefSections {
  const out = emptySections();
  if (!raw || typeof raw !== 'object') return out;
  for (const k of [...SECTION_KEYS, 'killed'] as (SectionKey | 'killed')[]) {
    const v = (raw as any)[k];
    if (!Array.isArray(v)) continue;
    (out as any)[k] = v
      .filter((l: any) => l && typeof l === 'object' && String(l.text || '').trim())
      .map((l: any) => ({
        id: String(l.id || lineId()),
        text: String(l.text),
        origin: (['owner', 'tool', 'ai'].includes(l.origin) ? l.origin : 'ai') as LineOrigin,
        ...(l.struck ? { struck: true } : {}),
        ...(l.evidence && l.evidence.callId ? { evidence: { callId: String(l.evidence.callId), ...(l.evidence.sampleId ? { sampleId: String(l.evidence.sampleId) } : {}), ...(l.evidence.actionId ? { actionId: String(l.evidence.actionId) } : {}) } } : {}),
        ...(l.at ? { at: String(l.at) } : {}),
      }));
  }
  return out;
}

export function readDelivery(raw: any): BriefDelivery {
  const d = raw && typeof raw === 'object' ? raw : {};
  return { whatsapp: !!d.whatsapp, telegram: !!d.telegram, messageText: String(d.messageText || '') };
}

export function readSources(raw: any): BriefSource[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s: any) => s && typeof s === 'object' && String(s.actionId || '').trim())
    .map((s: any, i: number) => ({
      id: String(s.id || `s${i + 1}`),
      actionId: String(s.actionId),
      args: s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? s.args : {},
      ...(s.evidence && s.evidence.callId ? { evidence: { callId: String(s.evidence.callId), ...(s.evidence.sampleId ? { sampleId: String(s.evidence.sampleId) } : {}), ...(s.evidence.actionId ? { actionId: String(s.evidence.actionId) } : {}) } } : {}),
      ...(s.saw ? { saw: String(s.saw) } : {}),
    }));
}

export function readTranscript(raw: any): TranscriptTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t: any) => t && typeof t === 'object')
    .map((t: any, i: number) => ({
      id: String(t.id || `t${i + 1}`),
      who: t.who === 'you' ? 'you' : 'ai',
      text: String(t.text || ''),
      at: String(t.at || ''),
      ...(t.kind ? { kind: String(t.kind) } : {}),
      ...(t.struck ? { struck: true } : {}),
    }));
}

// ---- what stops an approval --------------------------------------------------------------------

export type BriefRefusal = { section: SectionKey | 'sources' | 'output'; why: string };

/**
 * The four rules, in code rather than in a prompt — a prompt is a request, and the builder has
 * already shown it will talk its way past one. Each refusal names the missing thing in the words
 * the owner would use, because he reads these beside the section they belong to.
 *
 * `hasEvidence` answers "does this `ToolCall` row really exist?" — the service passes a checker so
 * this stays pure and testable.
 */
export function whyNotApprovable(brief: { sections: BriefSections; sources: BriefSource[]; delivery: BriefDelivery }, knownCallIds: Set<string>): BriefRefusal[] {
  const out: BriefRefusal[] = [];
  const sections = brief.sections || emptySections();

  // 1. His own words have to be in it. A brief made entirely of the AI's guesses is the old bug.
  if (!live(sections.want).some((l) => l.origin === 'owner')) {
    out.push({ section: 'want', why: 'This does not have your own words in it yet. Tell me what you want, in your words.' });
  }

  // 2. Look before you plan. Every source, every time.
  for (const s of brief.sources || []) {
    if (!s.evidence?.callId || !knownCallIds.has(s.evidence.callId)) {
      out.push({ section: 'sources', why: `I have not looked at ${sourceName(s)} myself yet, so I cannot promise what it will give you. Let me check it first.` });
    }
  }
  if (!(brief.sources || []).length) {
    out.push({ section: 'sources', why: 'Nothing is set up to fetch anything yet.' });
  }

  // 3. If it is going to message you, the message has to be written down. This is the whole point.
  const d = brief.delivery || emptyDelivery();
  if ((d.whatsapp || d.telegram) && !String(d.messageText || '').trim()) {
    const where = d.whatsapp && d.telegram ? 'the WhatsApp and Telegram messages' : d.whatsapp ? 'the WhatsApp message' : 'the Telegram message';
    out.push({ section: 'output', why: `You have not told me what ${where} should say. Write it out, and that is exactly what will arrive.` });
  }

  // 4. "It worked" has to mean something, or a run can call one email a success.
  if (!live(sections.success).length) {
    out.push({ section: 'success', why: 'Tell me what would make this a good run — a number, or what has to be in it. Without that, nothing can tell a bad run from a good one.' });
  }

  return out;
}

export function sourceName(s: BriefSource): string {
  const m = /^svc:([^.]+)\.(.+)$/.exec(String(s.actionId || ''));
  if (!m) return String(s.actionId || 'that source');
  const service = m[1].replace(/(^|[-_])([a-z])/g, (_x, a, b) => (a ? ' ' : '') + b.toUpperCase());
  const action = m[2].replace(/[_-]+/g, ' ');
  return `${service} · ${action}`;
}

// ---- what Codex is given -------------------------------------------------------------------------

/**
 * The build payload (BEA-1407 hands this to Codex; it lives here so it can be tested without a
 * runner).
 *
 * The owner decided this on 2026-08-22, against my advice, and he was right: **the whole
 * conversation goes**, not a summary. A summary is a small form wearing better handwriting, and
 * losing his nuance is the disease, not the cure. What makes it safe is the brief sitting on top of
 * it as the decider, and every killed idea being *marked* rather than removed — so a transcript
 * that still contains an idea he threw away cannot make anything rebuild it.
 */
export function forCodexPayload(brief: Brief): {
  decides: string;
  brief: { name: string; sections: { key: string; label: string; lines: BriefLine[] }[]; sources: BriefSource[]; delivery: BriefDelivery };
  transcript: TranscriptTurn[];
} {
  return {
    decides:
      'The brief below is what the owner read and approved. The conversation under it is the whole talk that produced it, every turn, nothing left out. ' +
      'Where the two disagree, THE BRIEF WINS. A line or a turn marked struck was killed by the owner — it is kept so you can see he considered it and said no. Never build a struck thing.',
    brief: {
      name: brief.name,
      sections: SECTION_KEYS.map((k) => ({ key: k, label: SECTION_LABELS[k], lines: brief.sections[k] || [] })),
      sources: brief.sources,
      delivery: brief.delivery,
    },
    transcript: brief.transcript,
  };
}
