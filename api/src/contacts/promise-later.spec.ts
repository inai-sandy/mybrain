import { promisesLater, laterWins } from './promise-later';

/**
 * BEA-1152. Rakesh's real message, 27 July 05:43:50, fifty seconds after he ticked his share page:
 * "Update sheet sending 12 clock". The board said received all day. He had not sent it.
 */
describe('a promise for later is not an arrival (BEA-1152)', () => {
  it('reads his real message as a promise', () => {
    expect(promisesLater('Update sheet sending 12 clock')).toBe(true);
  });

  it('catches the usual ways of saying it', () => {
    expect(promisesLater('I will send 11 am final sheet')).toBe(true);
    expect(promisesLater("I'll share it tonight")).toBe(true);
    expect(promisesLater('Sheet sending')).toBe(true);
    expect(promisesLater('will update by 5pm')).toBe(true);
  });

  it('believes them when they say it is already sent', () => {
    expect(promisesLater('Sent the sheet at 11')).toBe(false);
    expect(promisesLater('Shared already')).toBe(false);
    expect(promisesLater('done')).toBe(false);
  });

  it('a real report is not a promise', () => {
    expect(promisesLater('In Production: Magnetic touch PCB. In QC: coral PCB.')).toBe(false);
    expect(promisesLater('OT 8 members')).toBe(false);
  });

  it('says nothing about an empty message', () => {
    expect(promisesLater('')).toBe(false);
    expect(promisesLater('   ')).toBe(false);
  });
});

describe('which signal stands', () => {
  const t = (s: string) => new Date(`2026-07-27T${s}Z`);

  it('a later signal overrides an earlier one', () => {
    expect(laterWins(t('05:42:56'), t('05:43:50'))).toBe(true);
  });

  it('an older signal cannot undo a newer one', () => {
    expect(laterWins(t('05:43:50'), t('05:42:56'))).toBe(false);
  });

  it('an identical timestamp keeps what is already recorded — no flip-flop on a retry', () => {
    expect(laterWins(t('05:43:50'), t('05:43:50'))).toBe(false);
  });

  it('nothing recorded means the incoming signal stands', () => {
    expect(laterWins(null, t('05:00:00'))).toBe(true);
  });
});
