import { DaySignals } from './mind.types';

/**
 * The bar a Lab finding has to clear before it is allowed to exist. (BEA-1141)
 *
 * The owner said findings are "60% wrong". The record was worse: of 28 findings he judged 23 and
 * refuted 16 — 70%. Reading the refuted ones, they share one shape. This is a real one:
 *
 *   "Tasks requiring coordination with multiple internal stakeholders simultaneously are
 *    systematically deprioritised."
 *
 * It names nothing, proves nothing, and asks nothing. There is no way to agree with it, so he
 * refuses it. The same insight written properly:
 *
 *   "Update user manuals has been carried 43 days, Sales Executive Portal session 40. Both need
 *    someone else to show up. Nothing else has waited half as long. Give both away or kill them."
 *
 * So a finding must do three things, and this file checks all three against the day's real data.
 * A prompt asking nicely is a hope; this is the guarantee — a vague finding never gets stored.
 */

/** Words too common to prove a finding is talking about something real in the owner's day. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'had', 'you', 'your', 'they',
  'them', 'their', 'when', 'what', 'which', 'while', 'about', 'into', 'over', 'more', 'most', 'some',
  'than', 'then', 'there', 'these', 'those', 'been', 'being', 'were', 'was', 'are', 'not', 'but',
  'all', 'any', 'can', 'will', 'would', 'should', 'could', 'make', 'made', 'take', 'taken', 'get',
  'got', 'day', 'days', 'today', 'time', 'times', 'task', 'tasks', 'work', 'working', 'thing',
  'things', 'done', 'open', 'new', 'other', 'own', 'out', 'off', 'one', 'two', 'also', 'just',
  'very', 'much', 'many', 'such', 'like', 'need', 'needs', 'want', 'wants', 'keep', 'keeps',
  'tend', 'tends', 'often', 'usually', 'always', 'never', 'still', 'again',
  'was', 'her', 'his', 'its', 'who', 'why', 'how', 'now', 'yet', 'too', 'far', 'let', 'put',
  'say', 'saw', 'see', 'set', 'use', 'via', 'per', 'and', 'are', 'did', 'does', 'doing',
]);

/**
 * Phrases that mark a finding as a research abstract rather than an observation. Every one of these
 * was lifted from a finding the owner actually refuted.
 */
const ABSTRACT_PHRASES = [
  'systematically',
  'stakeholder',
  'cognitive load',
  'executive function',
  'multiple internal',
  'tends to be prioritis',
  'tends to be prioritiz',
  'are deprioritis',
  'are deprioritiz',
  'demonstrates a pattern',
  'exhibits a',
  'suggests a tendency',
  'appears to correlate',
  'there is a correlation',
  'high-cognitive',
  'context switching',
  'time management',
  'in general',
  'overall pattern',
];

export type FindingDraft = {
  statement?: string;
  subject?: string;
  action?: string | null;
  evidence?: { snippet?: string }[];
};

export type Grade = { ok: boolean; reason?: string };

/** Split text into the words worth matching on — long enough and not filler. */
export function keyWords(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    // 3, not 4 — real names are short. "Gym", "KYC", "RFQ" and most people's names would
    // otherwise be invisible to the gate, and a finding about them wrongly refused.
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Everything the owner's day actually contained, as words — task titles, categories, ideas,
 * meetings, email subjects. A finding has to overlap with this to be about something real.
 */
export function dayVocabulary(s: DaySignals): Set<string> {
  const bits: string[] = [];
  const all = [...s.tasks.done, ...s.tasks.skipped, ...s.tasks.postponed, ...s.tasks.created];
  for (const t of all) {
    bits.push(t.title || '');
    if (t.category) bits.push(t.category);
    if (t.sphere) bits.push(t.sphere);
  }
  for (const i of s.ideas || []) bits.push(i.title || '', i.content || '');
  for (const m of s.meetings || []) bits.push(m.title || '', m.summary || '', ...(m.decisions || []));
  for (const e of s.emails || []) bits.push(e.subject || '', e.from || '');
  if (s.story?.rawText) bits.push(s.story.rawText);
  for (const w of s.story?.workedBreakdown || []) bits.push(w.category || '');
  if (s.daySummary) bits.push(s.daySummary);
  return new Set(keyWords(bits.join(' ')));
}

/** Does the finding quote a real number — "43 days", "3 Sundays", "8 of 46"? */
export function quotesNumber(text: string): boolean {
  // A bare year isn't evidence. Note "43x" and "43rd" count — the digits are still their number,
  // so this must not demand a word boundary after them.
  return /(?:^|\D)\d{1,4}(?!\d)/.test(String(text || '').replace(/\b(19|20)\d{2}\b/g, ' '));
}

/** Does it name something out of the owner's own day, rather than a category of life? */
export function namesSomethingReal(text: string, vocab: Set<string>): string | null {
  for (const w of keyWords(text)) if (vocab.has(w)) return w;
  return null;
}

/** One concrete thing to do differently — not a paragraph, not empty, not a restatement. */
export function looksLikeAction(action: string | null | undefined, statement = ''): boolean {
  const a = String(action || '').trim();
  if (a.length < 8 || a.length > 200) return false;
  if (a.split(/\s+/).length < 3) return false;
  // A restatement of the finding is not an action.
  if (a.toLowerCase() === String(statement || '').trim().toLowerCase()) return false;
  return true;
}

export function usesAbstractLanguage(text: string): string | null {
  const t = String(text || '').toLowerCase();
  for (const p of ABSTRACT_PHRASES) if (t.includes(p)) return p;
  return null;
}

/**
 * The gate. A finding passes only if it names something out of the day, quotes a number, ends in
 * one action, and is written as an observation rather than an abstract.
 */
export function gradeFinding(f: FindingDraft, signals: DaySignals): Grade {
  const statement = String(f.statement || '').trim();
  if (!statement) return { ok: false, reason: 'no statement' };

  const abstract = usesAbstractLanguage(statement);
  if (abstract) return { ok: false, reason: `reads like a research abstract ("${abstract}")` };

  // The number may live in the statement or in the evidence it cites — both are the owner's data.
  const evidenceText = (f.evidence || []).map((e) => e?.snippet || '').join(' ');
  if (!quotesNumber(statement) && !quotesNumber(evidenceText)) {
    return { ok: false, reason: 'quotes no number from their own data' };
  }

  const vocab = dayVocabulary(signals);
  const named =
    namesSomethingReal(statement, vocab) ||
    namesSomethingReal(f.subject || '', vocab) ||
    namesSomethingReal(evidenceText, vocab);
  if (!named) return { ok: false, reason: 'names nothing from their actual day' };

  if (!looksLikeAction(f.action, statement)) return { ok: false, reason: 'ends in no single action' };

  return { ok: true };
}
