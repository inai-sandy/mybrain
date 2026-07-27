import { matchFinishedToOpen, sameWork, sig } from './finished-match';

/**
 * BEA-1146. Real titles from the owner's list — the 44-day "Update user manuals for Beakn Portal"
 * is the exact task that stayed open after he said he'd finished it.
 */
const OPEN = [
  { id: 'manuals', title: 'Update user manuals for Beakn Portal' },
  { id: 'srikar', title: 'Discuss installation charges with Srikar' },
  { id: 'captains', title: 'Conduct one-hour session with captains on the Sales Executive Portal' },
  { id: 'timeline', title: 'Define a clear product readiness timeline to share with the sales team' },
];

describe('matching what your story finished to what is still open (BEA-1146)', () => {
  it('ticks the task the story says you finished', () => {
    expect(matchFinishedToOpen(['Finished updating the user manuals for the Beakn Portal'], OPEN)).toEqual(['manuals']);
  });

  it('ticks nothing when the story is about different work', () => {
    expect(matchFinishedToOpen(['Booked the flights to Chennai'], OPEN)).toEqual([]);
  });

  it('one story line never closes two tasks', () => {
    // "portal" appears in three of these titles — an ambiguous phrase must not sweep them all.
    const got = matchFinishedToOpen(['Did the portal work'], OPEN);
    expect(got.length).toBeLessThanOrEqual(1);
  });

  it('picks the best match, not the first', () => {
    expect(matchFinishedToOpen(['Ran the one-hour session with the captains'], OPEN)).toEqual(['captains']);
  });

  it('two separate lines tick two separate tasks', () => {
    const got = matchFinishedToOpen(['Updated the user manuals', 'Discussed installation charges with Srikar'], OPEN);
    expect(got.sort()).toEqual(['manuals', 'srikar']);
  });

  it('the same line twice still only ticks one', () => {
    expect(matchFinishedToOpen(['Updated the user manuals', 'Updated user manuals'], OPEN)).toEqual(['manuals']);
  });

  it('ignores empty and junk input', () => {
    expect(matchFinishedToOpen([], OPEN)).toEqual([]);
    expect(matchFinishedToOpen(['', '  ', 'a to it'], OPEN)).toEqual([]);
    expect(matchFinishedToOpen(['Updated the user manuals'], [])).toEqual([]);
  });

  it('keeps the 60% rule short words cannot game', () => {
    expect(sameWork('Update user manuals', 'Update user manuals for Beakn Portal')).toBe(true);
    expect(sameWork('Call the plumber', 'Update user manuals')).toBe(false);
    expect(sig('the a of it').size).toBe(0); // nothing to match on
  });
});
