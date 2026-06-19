import { describe, expect, it } from 'vitest';
import { encryptBytes, decryptBytes, humanSize } from './documents';
import { b64encode, randomBytes } from './crypto';

describe('secure documents', () => {
  it('encrypts file bytes in the browser and decrypts them back', async () => {
    const text = 'PASSPORT-NUMBER-XYZ-12345 (very secret)';
    const bytes = new TextEncoder().encode(text);
    const { secret, cipher } = await encryptBytes(bytes, { filename: 'passport.txt', mime: 'text/plain', size: bytes.length });

    expect(secret.filename).toBe('passport.txt');
    expect(secret.mime).toBe('text/plain');
    // ciphertext must not contain the plaintext
    expect(new TextDecoder().decode(cipher)).not.toContain('PASSPORT');

    const out = await decryptBytes(secret, cipher);
    expect(new TextDecoder().decode(out)).toBe(text);
  });

  it('cannot be decrypted with the wrong file key', async () => {
    const bytes = new TextEncoder().encode('secret bytes');
    const { secret, cipher } = await encryptBytes(bytes, { filename: 'x.bin', mime: 'application/octet-stream', size: bytes.length });
    const wrong = { ...secret, fileKey: b64encode(randomBytes(32)) }; // a different valid-length key
    await expect(decryptBytes(wrong, cipher)).rejects.toBeDefined();
  });

  it('humanSize formats bytes/KB/MB', () => {
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(2048)).toBe('2 KB');
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
