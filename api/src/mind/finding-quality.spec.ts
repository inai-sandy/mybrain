import { DaySignals } from './mind.types';
import { gradeFinding, dayVocabulary, quotesNumber, looksLikeAction, usesAbstractLanguage, keepsNumbers, numbersIn } from './finding-quality';

/**
 * BEA-1141. The owner refuted 16 of the 23 Lab findings he judged — 70%. These tests use the real
 * refused sentence and the rewrite that would have passed, so the bar is pinned to actual data
 * rather than to a guess about what "good" means.
 */
const task = (title: string, extra: any = {}) => ({
  id: title, title, category: null, sphere: 'work', priority: 'medium', pinned: false, rolloverCount: 0, status: 'open', ...extra,
});

function day(): DaySignals {
  return {
    day: '2026-07-20',
    tasks: {
      done: [task('Reply to Madhuri about the invoice', { status: 'done' })],
      skipped: [],
      postponed: [task('Update user manuals', { rolloverCount: 43 }), task('Sales Executive Portal session', { rolloverCount: 40 })],
      created: [],
      counts: { done: 1, open: 2, skipped: 0, postponed: 2, created: 0 },
    },
    story: { rawText: 'Long day. Manuals still not touched.', mood: 'tired', workedMinutes: 400, workedBreakdown: null },
    daySummary: null,
    ideas: [],
    emails: [],
    meetings: [],
    hasSignal: true,
  };
}

const GOOD = {
  statement: 'You have carried Update user manuals 43 days and Sales Executive Portal session 40. Both need someone else to show up.',
  subject: 'Update user manuals',
  action: 'Give both away or kill them this week.',
  evidence: [{ snippet: 'Update user manuals (deferred 43x)' }],
};

describe('the bar a finding has to clear (BEA-1141)', () => {
  it('lets through a finding that names the thing, quotes the number and ends in an action', () => {
    expect(gradeFinding(GOOD, day()).ok).toBe(true);
  });

  it('refuses the real sentence the owner rejected', () => {
    const g = gradeFinding(
      {
        statement: 'Tasks requiring coordination with multiple internal stakeholders simultaneously are systematically deprioritised.',
        subject: 'coordination tasks',
        action: 'Try to be more aware of this pattern.',
      },
      day(),
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('abstract');
  });

  it('refuses a finding written about you instead of to you', () => {
    const g = gradeFinding(
      { ...GOOD, statement: "Sandeep's attention is captured by Update user manuals, deferred 43 times." },
      day(),
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('not to them');
  });

  it('refuses a rambling paragraph', () => {
    const long = 'You keep putting off Update user manuals, 43 days now, and the Sales Executive Portal session 40 days, ' +
      'and both of these need someone else to turn up before anything can move; meanwhile the rest of your list keeps ' +
      'turning over normally, which suggests the blocker is other people rather than the work itself in every case here.';
    const g = gradeFinding({ ...GOOD, statement: long }, day());
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('too long');
  });

  it('refuses a finding with no number in it', () => {
    const g = gradeFinding({ ...GOOD, statement: 'You keep pushing Update user manuals back.', evidence: [{ snippet: 'manuals again' }] }, day());
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('number');
  });

  it('refuses a finding about nothing in the actual day', () => {
    const g = gradeFinding(
      { statement: 'Your swimming sessions dropped to 2 this month.', subject: 'swimming', action: 'Book 3 slots for next week.', evidence: [] },
      day(),
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('names nothing');
  });

  it('refuses a finding with no action', () => {
    expect(gradeFinding({ ...GOOD, action: '' }, day()).reason).toContain('action');
    expect(gradeFinding({ ...GOOD, action: null }, day()).reason).toContain('action');
    expect(gradeFinding({ ...GOOD, action: 'Do it.' }, day()).reason).toContain('action'); // too thin
  });

  it('refuses an action that just repeats the statement', () => {
    expect(gradeFinding({ ...GOOD, action: GOOD.statement }, day()).ok).toBe(false);
  });

  it('accepts the number when it lives in the evidence rather than the sentence', () => {
    const g = gradeFinding({ ...GOOD, statement: 'Update user manuals is the oldest thing on your list.' }, day());
    expect(g.ok).toBe(true);
  });
});

describe('the pieces of the bar', () => {
  it('builds the day vocabulary from titles, story and categories', () => {
    const v = dayVocabulary(day());
    expect(v.has('manuals')).toBe(true);
    expect(v.has('madhuri')).toBe(true);
    expect(v.has('portal')).toBe(true);
    expect(v.has('gym')).toBe(false);
  });

  it('does not count a bare year as evidence', () => {
    expect(quotesNumber('You did this a lot in 2026.')).toBe(false);
    expect(quotesNumber('You did this 12 times.')).toBe(true);
  });

  it('knows an action from a paragraph', () => {
    expect(looksLikeAction('Give both away or kill them this week.')).toBe(true);
    expect(looksLikeAction('Yes')).toBe(false);
    expect(looksLikeAction('x'.repeat(250))).toBe(false);
  });

  it('spots abstract writing', () => {
    expect(usesAbstractLanguage('This is systematically avoided')).toBe('systematically');
    expect(usesAbstractLanguage('Update user manuals waited 43 days')).toBeNull();
  });
});

/**
 * BEA-1145. The rewrite pass may change WORDS ONLY. A model that helpfully rounds "deferred 20-36
 * times" up to "40 times" has fabricated evidence about the owner's own life, and he has no way
 * to catch it — so an invented number kills the rewrite outright.
 */
describe('a rewrite may never invent a number (BEA-1145)', () => {
  const orig = 'When the Beakn backlog is very large (many tasks deferred 20-36 times), he hands pieces to Dharmendra.';

  it('accepts a rewrite that keeps the numbers', () => {
    expect(keepsNumbers(orig, 'When Beakn tasks pile up — some deferred 20 to 36 times — you hand pieces to Dharmendra.')).toBe(true);
  });

  it('accepts a rewrite that drops a number', () => {
    expect(keepsNumbers(orig, 'When Beakn tasks pile up, you hand pieces to Dharmendra.')).toBe(true);
  });

  it('rejects a rewrite that invents one', () => {
    expect(keepsNumbers(orig, 'When Beakn tasks pile up — some deferred 40 times — you hand pieces to Dharmendra.')).toBe(false);
  });

  it('rejects a plausible-looking rounding', () => {
    expect(keepsNumbers('You carried this 43 days.', 'You have carried this for 6 weeks.')).toBe(false);
  });

  it('lists the numbers it found', () => {
    expect(numbersIn('43 days and 40 days, 8 of 46')).toEqual(['43', '40', '8', '46']);
    expect(numbersIn('no digits here')).toEqual([]);
  });
});
