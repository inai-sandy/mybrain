import { askDetail, askTag, digitsOf, numberedChoices, pickAsk, readOwnerAnswer, sameNumber } from './owner-reply';

/**
 * The rules that decide whether a WhatsApp message is the owner answering a parked run (BEA-1392 §H).
 *
 * They are tested on their own, without a database, because getting them wrong is how a reply meant
 * for a contact gets swallowed by the question matcher — and Contacts and Reminders are a live
 * feature the owner uses every day.
 */
describe('is this the owner?', () => {
  it('matches the same number with and without its country code', () => {
    expect(sameNumber('919885698665', '919885698665')).toBe(true);
    expect(sameNumber('+91 98856 98665', '919885698665')).toBe(true);
    expect(sameNumber('9885698665', '919885698665')).toBe(true); // saved without the country code
  });

  it('never matches a different number, or nothing at all', () => {
    expect(sameNumber('918885551234', '919885698665')).toBe(false);
    expect(sameNumber('', '919885698665')).toBe(false);
    expect(sameNumber('919885698665', '')).toBe(false);
    expect(sameNumber('12345', '919885698665')).toBe(false); // too short to be anyone's number
    expect(sameNumber('', '')).toBe(false);
  });

  it('digitsOf keeps only digits', () => {
    expect(digitsOf('+91 (988) 569-8665')).toBe('919885698665');
  });
});

describe('the question, as the owner reads it', () => {
  it('numbers the choices and says how to reply', () => {
    expect(numberedChoices(['Carry on', 'Stop'])).toBe('1 Carry on · 2 Stop');
    expect(askDetail('Instagram has failed 6 times.', ['Carry on', 'Stop'])).toBe('Instagram has failed 6 times. — reply 1, 2: 1 Carry on · 2 Stop');
  });

  it('a free-text question asks for words', () => {
    expect(askDetail('Which sheet should these go in?')).toContain('reply with your answer');
  });

  it('the tag is short, stable, and drawn from the question itself', () => {
    expect(askTag('a3f9c2de-1111-2222-3333-444455556666')).toBe('#a3f');
    expect(askTag('a3f9c2de-1111-2222-3333-444455556666')).toBe(askTag('a3f9c2de-1111-2222-3333-444455556666'));
    expect(askTag('')).toBe('');
  });
});

describe('which question a reply answers', () => {
  const older = { id: 'aaa11111-0000-0000-0000-000000000000', question: 'Older?', createdAt: new Date('2026-08-20T10:00:00Z') };
  const newer = { id: 'bbb22222-0000-0000-0000-000000000000', question: 'Newer?', createdAt: new Date('2026-08-21T10:00:00Z') };

  it('an untagged reply answers the oldest open question', () => {
    expect(pickAsk([newer, older], 'yes')?.id).toBe(older.id);
  });

  it('a tagged reply answers exactly the one it names, even when it is not the oldest', () => {
    expect(pickAsk([newer, older], '#bbb 2')?.id).toBe(newer.id);
  });

  it('a tag nobody recognises falls back to the oldest rather than being dropped', () => {
    expect(pickAsk([newer, older], '#zzz carry on')?.id).toBe(older.id);
  });

  it('nothing open means nothing to answer', () => {
    expect(pickAsk([], 'yes')).toBeNull();
  });
});

describe("what the owner's words mean", () => {
  const choices = ['Carry on', 'Stop', 'Retry in an hour'];

  it('a number picks that choice', () => {
    expect(readOwnerAnswer('2', choices)).toEqual({ answer: 'Stop', matched: 'number' });
    expect(readOwnerAnswer('3.', choices).answer).toBe('Retry in an hour');
    expect(readOwnerAnswer('option 1', choices).answer).toBe('Carry on');
  });

  it('a number nobody offered is not squeezed into a choice', () => {
    expect(readOwnerAnswer('9', choices)).toEqual({ answer: '9', matched: 'free' });
  });

  it('the words of a choice pick it too', () => {
    expect(readOwnerAnswer('carry on', choices).matched).toBe('word');
    expect(readOwnerAnswer('STOP', choices).answer).toBe('Stop');
    expect(readOwnerAnswer('carry', choices).answer).toBe('Carry on');
  });

  it('anything else is passed through exactly as he wrote it', () => {
    expect(readOwnerAnswer('use the marketing sheet instead', choices)).toEqual({ answer: 'use the marketing sheet instead', matched: 'free' });
  });

  it('the tag is addressing, not an answer — it is stripped', () => {
    expect(readOwnerAnswer('#a3f 1', choices).answer).toBe('Carry on');
    expect(readOwnerAnswer('#a3f', choices).answer).toBe('');
  });

  it('a free-text question keeps the whole message', () => {
    expect(readOwnerAnswer('1', []).answer).toBe('1');
  });
});
