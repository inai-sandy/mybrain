import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

// 32-byte key derived from CONNECTOR_KEY env (hashed so any-length input works).
function key(): Buffer {
  const raw = process.env.CONNECTOR_KEY || 'dev-insecure-connector-key-change-me';
  return createHash('sha256').update(raw).digest();
}

/** Encrypt a string with AES-256-GCM. Output: base64(iv).base64(tag).base64(ciphertext). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

/** Decrypt a value produced by encrypt(). Throws if tampered. */
export function decrypt(blob: string): string {
  const [ivB64, tagB64, ctB64] = blob.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
