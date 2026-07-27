import { WEEKDAYS } from './recurring.service';

/**
 * Which days a standing report is actually owed on. (BEA-1147)
 *
 * Before this, none. There was one global rest-day setting and nothing else, so every recurring
 * task was owed every working day. On Monday 27 July the owner's board said "4 received, 4 not" —
 * and two of the four were:
 *
 *   Send Friday night production status update        ← on a Monday
 *   Share the production plan at Wednesday's meeting  ← on a Monday
 *
 * A Friday report chased on a Monday makes the whole count meaningless, and it sent real WhatsApp
 * messages to a real colleague asking for the wrong thing. So the day belongs to the task.
 */

/** Long and short spellings of each weekday, mapped to the short form the app stores. */
const DAY_WORDS: Record<string, string> = {
  sunday: 'Sun', sundays: 'Sun', sun: 'Sun',
  monday: 'Mon', mondays: 'Mon', mon: 'Mon',
  tuesday: 'Tue', tuesdays: 'Tue', tue: 'Tue', tues: 'Tue',
  wednesday: 'Wed', wednesdays: 'Wed', wed: 'Wed', weds: 'Wed',
  thursday: 'Thu', thursdays: 'Thu', thu: 'Thu', thur: 'Thu', thurs: 'Thu',
  friday: 'Fri', fridays: 'Fri', fri: 'Fri',
  saturday: 'Sat', saturdays: 'Sat', sat: 'Sat',
};

/** Parse the stored JSON. Anything unreadable means "no schedule set", never "owed on no days". */
export function parseSchedule(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    if (!Array.isArray(a)) return null;
    const clean = [...new Set(a.filter((d: unknown) => typeof d === 'string' && WEEKDAYS.includes(d as string)))] as string[];
    return clean.length ? clean : null; // an empty set would mean "never owed" — treat as unset
  } catch {
    return null;
  }
}

export function serialiseSchedule(days: unknown): string | null {
  if (!Array.isArray(days)) return null;
  const clean = [...new Set(days.filter((d) => typeof d === 'string' && WEEKDAYS.includes(d as string)))] as string[];
  return clean.length ? JSON.stringify(WEEKDAYS.filter((d) => clean.includes(d))) : null;
}

/**
 * Is this report owed on that weekday?
 *
 * With its own schedule, the task's days decide and the global rest days no longer apply — an
 * owner who sets a Sunday report means it. With no schedule, the old rule stands: every day that
 * isn't a rest day.
 */
export function isOwedOn(scheduleDays: string | null | undefined, weekday: string, restDays: string[]): boolean {
  const own = parseSchedule(scheduleDays);
  if (own) return own.includes(weekday);
  return !restDays.includes(weekday);
}

/**
 * Read the days out of the task's own title, so the owner's existing reports can be seeded rather
 * than each one set by hand. Deliberately conservative: it only fires on a day the title actually
 * names, and returns null when it isn't sure — a wrong guess here chases a colleague on the wrong
 * day, which is the bug this exists to end.
 */
export function daysFromTitle(title: string): string[] | null {
  const t = String(title || '').toLowerCase();
  const found = new Set<string>();
  for (const w of t.replace(/[^a-z]+/g, ' ').split(' ')) {
    if (DAY_WORDS[w]) found.add(DAY_WORDS[w]);
  }
  if (found.size) return WEEKDAYS.filter((d) => found.has(d));
  // No weekday named. "daily" / "every day" / "every evening" means every working day, which is
  // already the no-schedule default — so say nothing rather than write a schedule that adds nothing.
  return null;
}

/** Plain English for a schedule, for the card and the chase message. */
export function scheduleLabel(scheduleDays: string | null | undefined): string {
  const own = parseSchedule(scheduleDays);
  if (!own) return 'every working day';
  if (own.length === 7) return 'every day';
  const weekdaysOnly = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  if (own.length === 5 && weekdaysOnly.every((d) => own.includes(d))) return 'Mon to Fri';
  return own.join(', ');
}
