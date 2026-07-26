import { pickWeeklyLine, weeklyMessage } from './weekly-line';

/**
 * BEA-1144. The Lab produced 48 nightly reads, 5 weekly reviews, 29 chains and 13 focus areas that
 * were almost never read. One line a week fixes that only if the line is worth reading — so the
 * hard requirement here is that a nothing-week sends NOTHING.
 */
const F = (action: string | null, daysSeen = 3, validated: string | null = null) => ({ action, statement: 'A finding.', daysSeen, validated });

describe('the one line a week (BEA-1144)', () => {
  it('prefers the action on the finding with the most days behind it', () => {
    const pick = pickWeeklyLine({
      findings: [F('Book the gym slot tonight.', 4), F('Give the manuals away or kill them.', 40)],
      review: { pattern: 'You did a lot.', experiment: 'Try mornings.' },
    });
    expect(pick).toEqual({ line: 'Give the manuals away or kill them.', source: 'action' });
  });

  it('falls back to the experiment, then the pattern', () => {
    expect(pickWeeklyLine({ findings: [], review: { pattern: 'You start strong on Monday.', experiment: 'Block Tuesday morning.' } }))
      .toEqual({ line: 'Block Tuesday morning.', source: 'experiment' });
    expect(pickWeeklyLine({ findings: [], review: { pattern: 'You start strong on Monday.', experiment: null } }))
      .toEqual({ line: 'You start strong on Monday.', source: 'pattern' });
  });

  it('SENDS NOTHING when there is nothing worth saying', () => {
    expect(pickWeeklyLine({ findings: [], review: null })).toBeNull();
    expect(pickWeeklyLine({ findings: [F(null)], review: { pattern: '', experiment: '  ' } })).toBeNull();
    expect(pickWeeklyLine({ findings: [F('Do it.')], review: null })).toBeNull(); // too thin to be a line
  });

  it('never repeats last week word for word', () => {
    const findings = [F('Give the manuals away or kill them.', 40)];
    const again = pickWeeklyLine({ findings, review: null, lastSent: 'Give the manuals away or kill them.' });
    expect(again).toBeNull();
    // punctuation drift is still the same sentence
    expect(pickWeeklyLine({ findings, review: null, lastSent: 'Give the manuals away, or kill them!' })).toBeNull();
  });

  it('moves to the next candidate rather than going silent on a repeat', () => {
    const pick = pickWeeklyLine({
      findings: [F('Give the manuals away or kill them.', 40)],
      review: { pattern: null, experiment: 'Block Tuesday morning.' },
      lastSent: 'Give the manuals away or kill them.',
    });
    expect(pick).toEqual({ line: 'Block Tuesday morning.', source: 'experiment' });
  });

  it('skips a refuted finding and a paragraph', () => {
    expect(pickWeeklyLine({ findings: [F('Ignore this one entirely please.', 40, 'refuted')], review: null })).toBeNull();
    expect(pickWeeklyLine({ findings: [F('x'.repeat(400), 40)], review: null })).toBeNull();
  });

  it('reads like a person, with the link', () => {
    const msg = weeklyMessage({ line: 'Give the manuals away or kill them.', source: 'action' });
    expect(msg).toContain('One thing worth doing this week');
    expect(msg).toContain('Give the manuals away or kill them.');
    expect(msg).toContain('https://mybrain.1site.ai/lab');
    expect(msg.length).toBeLessThan(400);
  });
});
