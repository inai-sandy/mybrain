import { isOwedOn, parseSchedule, serialiseSchedule, daysFromTitle, scheduleLabel } from './schedule';

/**
 * BEA-1147. On Monday 27 July the owner's board read "4 received, 4 not received" — and two of the
 * four were "Send Friday night production status update" and "Share the production plan at
 * Wednesday's meeting". Both were owed on a Monday because a recurring task had no schedule at all.
 * The titles here are his, verbatim.
 */
describe('a report is owed on its own days (BEA-1147)', () => {
  const noRest: string[] = [];
  const sundayOff = ['Sun'];

  it("a Friday report is not owed on a Monday", () => {
    const fri = JSON.stringify(['Fri']);
    expect(isOwedOn(fri, 'Fri', noRest)).toBe(true);
    expect(isOwedOn(fri, 'Mon', noRest)).toBe(false);
  });

  it('no schedule keeps the old rule: every day that is not a rest day', () => {
    expect(isOwedOn(null, 'Mon', sundayOff)).toBe(true);
    expect(isOwedOn(null, 'Sun', sundayOff)).toBe(false);
  });

  it('its own days beat the global rest day — a Sunday report is real if he set one', () => {
    expect(isOwedOn(JSON.stringify(['Sun']), 'Sun', sundayOff)).toBe(true);
  });

  it('a broken or empty schedule means unset, never "owed on no days"', () => {
    expect(parseSchedule('not json')).toBeNull();
    expect(parseSchedule('[]')).toBeNull();
    expect(parseSchedule('["Nonsense"]')).toBeNull();
    expect(isOwedOn('[]', 'Mon', sundayOff)).toBe(true); // falls back, never silently stops
  });

  it('stores days in week order and drops rubbish', () => {
    expect(serialiseSchedule(['Fri', 'Mon', 'Fri'])).toBe('["Mon","Fri"]');
    expect(serialiseSchedule(['Blursday'])).toBeNull();
    expect(serialiseSchedule('Mon')).toBeNull();
  });
});

describe('reading the day out of his real titles', () => {
  it('finds the day the title names', () => {
    expect(daysFromTitle('Send Friday night production status update')).toEqual(['Fri']);
    expect(daysFromTitle("Share the production plan at Wednesday's meeting")).toEqual(['Wed']);
    expect(daysFromTitle('Send Monday night production status update')).toEqual(['Mon']);
  });

  it('handles more than one day, in week order', () => {
    expect(daysFromTitle('Send the update on Tuesday and Thursday')).toEqual(['Tue', 'Thu']);
  });

  it('says nothing when the title names no day — never guesses', () => {
    expect(daysFromTitle('Send the daily production update')).toBeNull();
    expect(daysFromTitle('Send daily Haasya production update by 7PM')).toBeNull();
    expect(daysFromTitle('Report any problems or issues as soon as they come up')).toBeNull();
  });

  it('reads plain English back out', () => {
    expect(scheduleLabel(null)).toBe('every working day');
    expect(scheduleLabel(JSON.stringify(['Fri']))).toBe('Fri');
    expect(scheduleLabel(JSON.stringify(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']))).toBe('Mon to Fri');
  });
});
