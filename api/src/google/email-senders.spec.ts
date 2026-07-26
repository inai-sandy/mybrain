import { isBlockedSender, isNoReplySender, senderAddress, senderLocalPart } from './email-senders';

/**
 * BEA-1125: tested against the owner's REAL sender list. The rule has to remove the machine mail
 * that was drowning his brain WITHOUT touching a single colleague — one wrong match here deletes
 * real work correspondence.
 */
describe('senderAddress — pulling the address out of a From header', () => {
  it('handles a plain address', () => {
    expect(senderAddress('hr@kiot.io')).toBe('hr@kiot.io');
  });

  it('handles a display name with angle brackets', () => {
    expect(senderAddress('"Airtel IoT" <m2m_info@airtel.com>')).toBe('m2m_info@airtel.com');
  });

  it('lowercases and trims', () => {
    expect(senderAddress('  HR@Kiot.IO ')).toBe('hr@kiot.io');
  });

  it('survives empty input', () => {
    expect(senderAddress('')).toBe('');
    expect(senderAddress(null)).toBe('');
    expect(senderLocalPart(undefined)).toBe('');
  });
});

describe('isNoReplySender — the automatic rule', () => {
  it("removes the owner's single biggest sender (66 emails)", () => {
    expect(isNoReplySender('noreply@communication.feturtles.com')).toBe(true);
  });

  it('removes the other four machine senders found in his brain', () => {
    expect(isNoReplySender('google-workspace-alerts-noreply@google.com')).toBe(true);
    expect(isNoReplySender('noreply@mycii.in')).toBe(true);
    expect(isNoReplySender('no-reply@email.zebpay.com')).toBe(true);
    expect(isNoReplySender('donotreply@paypal.com')).toBe(true);
  });

  it('catches the other machine spellings', () => {
    expect(isNoReplySender('do-not-reply@x.com')).toBe(true);
    expect(isNoReplySender('mailer-daemon@x.com')).toBe(true);
    expect(isNoReplySender('bounce@x.com')).toBe(true);
    expect(isNoReplySender('bounces@x.com')).toBe(true);
    expect(isNoReplySender('postmaster@x.com')).toBe(true);
  });

  it('KEEPS every real colleague — this is the one that must not break', () => {
    for (const a of [
      'hr@kiot.io', 'prashant@kiot.io', 'renuka@kiot.io', 'praveen@kiot.io', 'naveen@kiot.io',
      'swathi@kiot.io', 'farooq@kiot.io', 'kalyani@kiot.io', 'inventory@kiot.io', 'purchases@kiot.io',
      'vbankoti@vincular.in', 'sohail@themvp.in', 'snehith.v@truzonsolar.com', 'thirupathi.rao@dtdsgp.com',
    ]) {
      expect(isNoReplySender(a)).toBe(false);
    }
  });

  it('keeps the Airtel alerts — not a no-reply address, so blocking it is a manual choice', () => {
    expect(isNoReplySender('m2m_info@airtel.com')).toBe(false);
  });

  it('does not fire on a name that merely contains the letters', () => {
    expect(isNoReplySender('replyto@kiot.io')).toBe(false);
    expect(isNoReplySender('noreplytoday@kiot.io')).toBe(false);
    expect(isNoReplySender('bouncer@kiot.io')).toBe(false);
  });

  it('only looks at the local part — a real mailbox on a no-reply domain is kept', () => {
    expect(isNoReplySender('prashant@no-reply.example.com')).toBe(false);
  });
});

describe('isBlockedSender — the rule plus the owner\'s own block list', () => {
  it('blocks anything the automatic rule catches, with no list', () => {
    expect(isBlockedSender('noreply@communication.feturtles.com')).toBe(true);
  });

  it('blocks an address the owner added by hand', () => {
    expect(isBlockedSender('m2m_info@airtel.com', ['m2m_info@airtel.com'])).toBe(true);
  });

  it('matches the blocked address inside a display-name header', () => {
    expect(isBlockedSender('"Airtel IoT" <m2m_info@airtel.com>', ['m2m_info@airtel.com'])).toBe(true);
  });

  it('is case-insensitive on both sides', () => {
    expect(isBlockedSender('M2M_Info@Airtel.com', ['m2m_info@AIRTEL.COM'])).toBe(true);
  });

  it('blocks per address, never per domain — a colleague on a blocked domain is safe', () => {
    expect(isBlockedSender('hr@kiot.io', ['noreply@kiot.io'])).toBe(false);
  });

  it('leaves everyone else alone', () => {
    expect(isBlockedSender('prashant@kiot.io', ['m2m_info@airtel.com'])).toBe(false);
    expect(isBlockedSender('', ['m2m_info@airtel.com'])).toBe(false);
  });
});
