import { describe, expect, it } from 'vitest';
import { generatePassword, generatePassphrase, isWeakPassword } from './generator';

describe('generatePassword', () => {
  it('honors the requested length and is different each time', () => {
    const a = generatePassword({ length: 24, symbols: true, numbers: true, uppercase: true });
    const b = generatePassword({ length: 24, symbols: true, numbers: true, uppercase: true });
    expect(a).toHaveLength(24);
    expect(a).not.toBe(b);
  });

  it('includes each enabled character class', () => {
    const p = generatePassword({ length: 30, symbols: true, numbers: true, uppercase: true });
    expect(/[a-z]/.test(p)).toBe(true);
    expect(/[A-Z]/.test(p)).toBe(true);
    expect(/\d/.test(p)).toBe(true);
    expect(/[^A-Za-z0-9]/.test(p)).toBe(true);
  });

  it('omits symbols and digits when disabled', () => {
    const p = generatePassword({ length: 24, symbols: false, numbers: false, uppercase: true });
    expect(/[^A-Za-z]/.test(p)).toBe(false);
  });
});

describe('generatePassphrase', () => {
  it('produces the requested number of words plus a trailing number', () => {
    const p = generatePassphrase(4);
    const parts = p.split('-');
    expect(parts).toHaveLength(5); // 4 words + number
    expect(/^\d+$/.test(parts[4])).toBe(true);
  });
});

describe('isWeakPassword', () => {
  it('flags short or single-class passwords, passes strong ones', () => {
    expect(isWeakPassword('abc')).toBe(true);
    expect(isWeakPassword('aaaaaaaaaaaa')).toBe(true); // long but one class
    expect(isWeakPassword('Tr0ub4dour&3xtra')).toBe(false);
  });
});
