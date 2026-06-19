// Vault zero-knowledge crypto engine (BEA-345).
//
// EVERYTHING here runs on the owner's device. The server only ever sees the
// ciphertext + wrapped keys produced below — never a passphrase, never a raw
// key, never a plaintext secret. Keys live in memory as non-extractable
// WebCrypto keys and are wiped on lock.
//
// Scheme:
//   masterKey   = Argon2id(passphrase, salt)          — memory-hard, human secret
//   recoveryKey = 32 random bytes (shown once)         — high-entropy backup
//   vaultKey    = 32 random bytes                       — the real vault key
//   vaultKey is WRAPPED (AES-256-GCM) by BOTH masterKey and recoveryKey, so
//   either one can unlock. Each item gets a random dataKey; the item payload is
//   AES-256-GCM encrypted with the dataKey, and the dataKey is wrapped by the
//   vaultKey (envelope encryption — changing the passphrase re-wraps only the
//   vaultKey, never every item).

import { argon2id } from 'hash-wasm';

export type KdfParams = { type: 'argon2id'; memorySize: number; iterations: number; parallelism: number; hashLength: number };

// 64 MiB, 3 passes — a sensible memory-hard default for an interactive unlock.
export const DEFAULT_KDF: KdfParams = { type: 'argon2id', memorySize: 65536, iterations: 3, parallelism: 1, hashLength: 32 };

const subtle = (): SubtleCrypto => {
  const c = (globalThis as any).crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available in this environment');
  return c.subtle;
};

// Hand WebCrypto a plain ArrayBuffer view (sidesteps the Uint8Array<ArrayBufferLike> typing).
const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

// ---- bytes / base64 helpers ----
export function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  (globalThis as any).crypto.getRandomValues(a);
  return a;
}

export function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- a single AES-256-GCM ciphertext (iv + ct, both base64) ----
export type Cipher = { iv: string; ct: string };

/** Import 32 raw key bytes as an AES-256-GCM key. Non-extractable by default. */
export async function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('AES key must be 32 bytes');
  return subtle().importKey('raw', ab(raw), { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

export async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Cipher> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: ab(iv) }, key, ab(plaintext));
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

export async function aesDecrypt(key: CryptoKey, c: Cipher): Promise<Uint8Array> {
  // Throws if the key is wrong or the ciphertext was tampered with (GCM auth tag).
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: ab(b64decode(c.iv)) }, key, ab(b64decode(c.ct)));
  return new Uint8Array(pt);
}

// ---- KDF ----
/** Derive a 32-byte master key from the passphrase via Argon2id (memory-hard). */
export async function deriveKeyBytes(passphrase: string, salt: Uint8Array, params: KdfParams = DEFAULT_KDF): Promise<Uint8Array> {
  const hex = await argon2id({
    password: passphrase,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySize,
    hashLength: params.hashLength,
    outputType: 'hex',
  });
  // hash-wasm returns a hex string; turn it back into raw bytes.
  const out = new Uint8Array(params.hashLength);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export async function deriveMasterKey(passphrase: string, salt: Uint8Array, params: KdfParams = DEFAULT_KDF): Promise<CryptoKey> {
  return importAesKey(await deriveKeyBytes(passphrase, salt, params), false);
}

// ---- vault key wrapping (wrap the RAW vault-key bytes with a wrapping key) ----
export async function wrapVaultKey(wrappingKey: CryptoKey, vaultKeyRaw: Uint8Array): Promise<Cipher> {
  return aesEncrypt(wrappingKey, vaultKeyRaw);
}

/** Unwrap the vault key. Throws on a wrong passphrase/recovery key (GCM auth fails). */
export async function unwrapVaultKeyRaw(wrappingKey: CryptoKey, wrapped: Cipher): Promise<Uint8Array> {
  return aesDecrypt(wrappingKey, wrapped);
}

// ---- verifier: lets us confirm a vault key is intact (encrypts a known constant) ----
const VERIFIER_CONST = 'mybrain-vault-v1';
export async function makeVerifier(vaultKey: CryptoKey): Promise<Cipher> {
  return aesEncrypt(vaultKey, enc.encode(VERIFIER_CONST));
}
export async function checkVerifier(vaultKey: CryptoKey, verifier: Cipher): Promise<boolean> {
  try {
    return dec.decode(await aesDecrypt(vaultKey, verifier)) === VERIFIER_CONST;
  } catch {
    return false;
  }
}

// ---- envelope-encrypted item blob ----
export type EncryptedBlob = { v: 1; item: Cipher; dataKey: Cipher };

/** Encrypt an item payload object: random dataKey encrypts the payload; vaultKey wraps the dataKey. */
export async function encryptItem(vaultKey: CryptoKey, payload: unknown): Promise<EncryptedBlob> {
  const dataKeyRaw = randomBytes(32);
  const dataKey = await importAesKey(dataKeyRaw, false);
  const item = await aesEncrypt(dataKey, enc.encode(JSON.stringify(payload)));
  const dk = await aesEncrypt(vaultKey, dataKeyRaw);
  return { v: 1, item, dataKey: dk };
}

export async function decryptItem<T = any>(vaultKey: CryptoKey, blob: EncryptedBlob): Promise<T> {
  const dataKeyRaw = await aesDecrypt(vaultKey, blob.dataKey);
  const dataKey = await importAesKey(dataKeyRaw, false);
  const pt = await aesDecrypt(dataKey, blob.item);
  return JSON.parse(dec.decode(pt)) as T;
}

// ---- recovery key (high-entropy code shown once at setup) ----
// 32 random bytes rendered in Crockford base32, grouped 5×N for readability.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32ToBytes(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export type RecoveryKey = { display: string; bytes: Uint8Array };

/** Generate a fresh recovery key. `display` is what the user saves; `bytes` is the wrapping key. */
export function generateRecoveryKey(): RecoveryKey {
  const bytes = randomBytes(32);
  const raw = bytesToBase32(bytes);
  const display = (raw.match(/.{1,5}/g) || [raw]).join('-');
  return { display, bytes };
}

/** Parse a recovery key the user typed back in to its 32 wrapping-key bytes. */
export function recoveryKeyToBytes(display: string): Uint8Array {
  return base32ToBytes(display).slice(0, 32);
}
