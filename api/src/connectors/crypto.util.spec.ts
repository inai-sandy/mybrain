import { encrypt, decrypt } from './crypto.util';

describe('crypto.util', () => {
  it('round-trips a value and never stores it in plaintext', () => {
    const secret = 'sm_supersecret_value_123';
    const blob = encrypt(secret);
    expect(blob).not.toContain(secret);
    expect(decrypt(blob)).toBe(secret);
  });

  it('rejects tampered ciphertext', () => {
    const parts = encrypt('x').split('.');
    parts[2] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });
});
