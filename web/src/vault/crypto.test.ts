import { describe, expect, it } from 'vitest';
import {
  randomBytes,
  b64encode,
  b64decode,
  importAesKey,
  aesEncrypt,
  aesDecrypt,
  deriveMasterKey,
  deriveKeyBytes,
  wrapVaultKey,
  unwrapVaultKeyRaw,
  makeVerifier,
  checkVerifier,
  encryptItem,
  decryptItem,
  generateRecoveryKey,
  recoveryKeyToBytes,
  bytesToBase32,
  base32ToBytes,
  KdfParams,
} from './crypto';

// Fast KDF for tests (the real default is 64 MiB / 3 passes).
const FAST: KdfParams = { type: 'argon2id', memorySize: 8192, iterations: 1, parallelism: 1, hashLength: 32 };

describe('base64', () => {
  it('round-trips arbitrary bytes', () => {
    const b = randomBytes(40);
    expect(Array.from(b64decode(b64encode(b)))).toEqual(Array.from(b));
  });
});

describe('AES-256-GCM', () => {
  it('encrypts and decrypts back to the same bytes', async () => {
    const key = await importAesKey(randomBytes(32));
    const msg = new TextEncoder().encode('hunter2 — the secret');
    const c = await aesEncrypt(key, msg);
    expect(c.iv).toBeTruthy();
    expect(c.ct).toBeTruthy();
    const back = await aesDecrypt(key, c);
    expect(new TextDecoder().decode(back)).toBe('hunter2 — the secret');
  });

  it('FAILS to decrypt with the wrong key', async () => {
    const key = await importAesKey(randomBytes(32));
    const wrong = await importAesKey(randomBytes(32));
    const c = await aesEncrypt(key, new TextEncoder().encode('secret'));
    await expect(aesDecrypt(wrong, c)).rejects.toBeDefined();
  });

  it('FAILS on tampered ciphertext (GCM auth tag)', async () => {
    const key = await importAesKey(randomBytes(32));
    const c = await aesEncrypt(key, new TextEncoder().encode('secret'));
    const bytes = b64decode(c.ct);
    bytes[0] ^= 0xff; // flip a bit
    await expect(aesDecrypt(key, { iv: c.iv, ct: b64encode(bytes) })).rejects.toBeDefined();
  });
});

describe('Argon2id KDF', () => {
  it('is deterministic for the same passphrase + salt', async () => {
    const salt = randomBytes(16);
    const a = await deriveKeyBytes('correct horse battery staple', salt, FAST);
    const b = await deriveKeyBytes('correct horse battery staple', salt, FAST);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(32);
  });

  it('gives a different key for a different passphrase', async () => {
    const salt = randomBytes(16);
    const a = await deriveKeyBytes('passphrase one', salt, FAST);
    const b = await deriveKeyBytes('passphrase two', salt, FAST);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('vault key wrapping (passphrase OR recovery key unlocks)', () => {
  it('either wrapping key recovers the same vault key; wrong passphrase fails', async () => {
    const salt = randomBytes(16);
    const vaultKeyRaw = randomBytes(32);

    const masterKey = await deriveMasterKey('master-pass', salt, FAST);
    const recovery = generateRecoveryKey();
    const recoveryKey = await importAesKey(recovery.bytes);

    const wrappedByPass = await wrapVaultKey(masterKey, vaultKeyRaw);
    const wrappedByRecovery = await wrapVaultKey(recoveryKey, vaultKeyRaw);

    // passphrase path
    const viaPass = await unwrapVaultKeyRaw(await deriveMasterKey('master-pass', salt, FAST), wrappedByPass);
    expect(Array.from(viaPass)).toEqual(Array.from(vaultKeyRaw));

    // recovery-key path
    const viaRecovery = await unwrapVaultKeyRaw(await importAesKey(recoveryKeyToBytes(recovery.display)), wrappedByRecovery);
    expect(Array.from(viaRecovery)).toEqual(Array.from(vaultKeyRaw));

    // wrong passphrase
    await expect(unwrapVaultKeyRaw(await deriveMasterKey('WRONG', salt, FAST), wrappedByPass)).rejects.toBeDefined();
  });
});

describe('verifier', () => {
  it('passes with the right vault key, fails with a different one', async () => {
    const vaultKey = await importAesKey(randomBytes(32));
    const v = await makeVerifier(vaultKey);
    expect(await checkVerifier(vaultKey, v)).toBe(true);
    expect(await checkVerifier(await importAesKey(randomBytes(32)), v)).toBe(false);
  });
});

describe('envelope item encryption', () => {
  it('round-trips a structured payload through the vault key', async () => {
    const vaultKey = await importAesKey(randomBytes(32));
    const payload = { username: 'sandy', password: '@Arya283100', totp: 'JBSWY3DPEHPK3PXP', notes: 'main email' };
    const blob = await encryptItem(vaultKey, payload);
    expect(blob.v).toBe(1);
    // The serialized blob must not contain any plaintext secret.
    const serialized = JSON.stringify(blob);
    expect(serialized).not.toContain('@Arya283100');
    expect(serialized).not.toContain('JBSWY3DPEHPK3PXP');
    const back = await decryptItem(vaultKey, blob);
    expect(back).toEqual(payload);
  });

  it('cannot be decrypted by a different vault key', async () => {
    const blob = await encryptItem(await importAesKey(randomBytes(32)), { password: 'x' });
    await expect(decryptItem(await importAesKey(randomBytes(32)), blob)).rejects.toBeDefined();
  });
});

describe('recovery key encoding', () => {
  it('base32 round-trips bytes', () => {
    const b = randomBytes(32);
    expect(Array.from(base32ToBytes(bytesToBase32(b)))).toEqual(Array.from(b));
  });

  it('generated key parses back to its wrapping bytes (dashes/spaces tolerated)', () => {
    const rk = generateRecoveryKey();
    expect(rk.display).toContain('-');
    expect(Array.from(recoveryKeyToBytes(rk.display))).toEqual(Array.from(rk.bytes));
    expect(Array.from(recoveryKeyToBytes(rk.display.replace(/-/g, ' ').toLowerCase()))).toEqual(Array.from(rk.bytes));
  });
});
