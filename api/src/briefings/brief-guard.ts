/**
 * What a briefing is allowed to turn into. (BEA-1151)
 *
 * On 27 July the owner said, word for word:
 *
 *   "This is to Rakesh. So EVERY DAY rakesh has to send production updates based the plan. He has
 *    to clearly communicate if we are going according to plan. He has to send updates without
 *    missing both Haasya and MIC."
 *
 * What came out, in the same second:
 *
 *   Send MONDAY night production status update
 *   Share the production plan at WEDNESDAY's meeting
 *   Send FRIDAY night production status update
 *   summary: "...production status updates EVERY WEEK"
 *
 * Three weekdays he never said. "Every day" turned into "every week". And Haasya and MIC — the one
 * specific thing he asked for — dropped entirely. Those tasks then drove a real WhatsApp message to
 * a real colleague at 05:30 asking for "today's Monday night production status update".
 *
 * The prompt already said "Do NOT invent work that was not mentioned." It did it anyway. So this is
 * the guarantee rather than the request: a day, date, time or number may only appear in a task if
 * it appears in what he actually said.
 */

const WEEKDAYS: Record<string, string> = {
  mon: 'monday', monday: 'monday', mondays: 'monday',
  tue: 'tuesday', tues: 'tuesday', tuesday: 'tuesday', tuesdays: 'tuesday',
  wed: 'wednesday', weds: 'wednesday', wednesday: 'wednesday', wednesdays: 'wednesday',
  thu: 'thursday', thur: 'thursday', thurs: 'thursday', thursday: 'thursday', thursdays: 'thursday',
  fri: 'friday', friday: 'friday', fridays: 'friday',
  sat: 'saturday', saturday: 'saturday', saturdays: 'saturday',
  sun: 'sunday', sunday: 'sunday', sundays: 'sunday',
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Spelled and ordinal forms of the same figure, so "third floor" and "3rd floor" don't disagree. */
const NUMBER_WORDS: Record<string, string> = {
  one: '1', first: '1', '1st': '1',
  two: '2', second: '2', '2nd': '2', both: '2',
  three: '3', third: '3', '3rd': '3',
  four: '4', fourth: '4', '4th': '4',
  five: '5', fifth: '5', '5th': '5',
  six: '6', sixth: '6', '6th': '6',
  seven: '7', seventh: '7', '7th': '7',
  eight: '8', eighth: '8', '8th': '8',
  nine: '9', ninth: '9', '9th': '9',
  ten: '10', tenth: '10', '10th': '10',
  eleven: '11', twelve: '12',
};

export type Cadence = 'daily' | 'weekly' | 'monthly' | null;

/**
 * Every day, date, clock time and figure a piece of text commits to — normalised, so the two sides
 * of a comparison speak the same language.
 */
export function temporalTokens(text: string): Set<string> {
  const out = new Set<string>();
  const t = String(text || '').toLowerCase();

  // clock times: "5pm", "5 pm", "17:30", "5:30pm"
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/g)) out.add(`time:${m[1]}${m[2] ? ':' + m[2] : ''}${m[3]}`);
  for (const m of t.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) out.add(`time:${m[1]}:${m[2]}`);

  for (const w of t.replace(/[^a-z0-9:]+/g, ' ').split(' ')) {
    if (!w) continue;
    if (WEEKDAYS[w]) out.add(`day:${WEEKDAYS[w]}`);
    if (MONTHS.includes(w)) out.add(`month:${w}`);
    if (NUMBER_WORDS[w]) out.add(`num:${NUMBER_WORDS[w]}`);
    // a bare figure, but not one already counted as part of a clock time
    if (/^\d{1,4}$/.test(w) && !t.includes(`${w}:`) && !new RegExp(`${w}\\s*(am|pm)`).test(t)) out.add(`num:${w}`);
  }
  return out;
}

/**
 * What the draft committed to that he never said. The one thing this must never do is fail open:
 * if a token cannot be found in his words, it was invented.
 */
export function inventedTemporal(raw: string, drafted: string): string[] {
  const said = temporalTokens(raw);
  return [...temporalTokens(drafted)].filter((tok) => !said.has(tok));
}

/** How often he said it should happen — from HIS words only. No cadence said means a one-off. */
export function cadenceFromWords(raw: string): Cadence {
  const t = String(raw || '').toLowerCase();
  if (/\b(every ?day|everyday|each day|daily|day to day|day-to-day)\b/.test(t)) return 'daily';
  if (/\b(every week|each week|weekly|once a week)\b/.test(t)) return 'weekly';
  if (/\b(every month|each month|monthly|once a month)\b/.test(t)) return 'monthly';
  return null;
}

/**
 * The things he explicitly said not to miss. "without missing both Haasya and MIC" is the whole
 * point of that briefing, and it vanished — a briefing that loses its one constraint has failed
 * even when every sentence in it reads well.
 */
export function mustKeepTerms(raw: string): string[] {
  const t = String(raw || '');
  const out = new Set<string>();
  const patterns = [
    /without missing\s+(?:both\s+)?([^.!?\n]+)/gi,
    /(?:don'?t|do not|never)\s+miss\s+(?:out on\s+)?([^.!?\n]+)/gi,
    /make sure (?:to include|of|he includes|she includes|they include)\s+([^.!?\n]+)/gi,
  ];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      for (const part of String(m[1]).split(/\band\b|,|&/i)) {
        const term = part.trim().replace(/^(the|a|an|both)\s+/i, '').replace(/[.:;]+$/, '').trim();
        // Only distinctive terms — "it", "them", "updates" prove nothing.
        if (term.length >= 3 && term.split(/\s+/).length <= 4 && !/^(it|them|this|that|those|these|updates?|reports?|anything|everything)$/i.test(term)) out.add(term);
      }
    }
  }
  return [...out];
}

export type DraftLike = { title: string; note?: string; [k: string]: any };
export type Graded<T> = {
  kept: T[];
  dropped: { title: string; invented: string[] }[];
  cadence: Cadence;
  /** Constraints he stated that no task carries — appended rather than lost. */
  missingTerms: string[];
};

const pretty = (tok: string) => tok.replace(/^(day|month|num|time):/, '');

/**
 * The gate. Any task committing to a day, date, time or figure he never said is dropped, and the
 * caller decides what to do with an empty result — this never quietly returns nothing and lets the
 * briefing evaporate.
 */
export function gradeBriefDraft<T extends DraftLike>(raw: string, tasks: T[]): Graded<T> {
  const kept: T[] = [];
  const dropped: { title: string; invented: string[] }[] = [];
  for (const t of tasks || []) {
    const invented = inventedTemporal(raw, `${t.title || ''} ${t.note || ''}`);
    if (invented.length) dropped.push({ title: t.title, invented: invented.map(pretty) });
    else kept.push(t);
  }
  const said = mustKeepTerms(raw);
  const covered = kept.map((t) => `${t.title || ''} ${t.note || ''}`.toLowerCase()).join(' ');
  const missingTerms = said.filter((term) => !covered.includes(term.toLowerCase()));
  return { kept, dropped, cadence: cadenceFromWords(raw), missingTerms };
}

/** A summary that contradicts what he said is worse than no summary — "every day" is not "every week". */
export function summaryContradicts(raw: string, summary: string): boolean {
  const said = cadenceFromWords(raw);
  const wrote = cadenceFromWords(summary);
  return !!said && !!wrote && said !== wrote;
}
