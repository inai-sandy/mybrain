// Client-side file encryption for Secure documents. The file is encrypted in the browser with a
// random per-file key; that key + filename/mime live inside the item's vault-encrypted blob, so the
// server only ever sees opaque ciphertext bytes.
import { randomBytes, b64encode, b64decode } from './crypto';

const subtle = (): SubtleCrypto => (globalThis as any).crypto.subtle;
const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export type DocMeta = { filename: string; mime: string; size: number; fileKey: string; fileIv: string };

/** Read a File's bytes — uses arrayBuffer() where available, else FileReader. */
async function fileBytes(file: File): Promise<Uint8Array> {
  if (typeof (file as any).arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(file);
  });
}

/** Encrypt raw bytes + their metadata (the testable core). */
export async function encryptBytes(bytes: Uint8Array, meta: { filename: string; mime: string; size: number }): Promise<{ secret: DocMeta; cipher: Uint8Array }> {
  const fileKeyRaw = randomBytes(32);
  const key = await subtle().importKey('raw', ab(fileKeyRaw), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: ab(iv) }, key, ab(bytes)));
  return { secret: { ...meta, fileKey: b64encode(fileKeyRaw), fileIv: b64encode(iv) }, cipher: ct };
}

export async function encryptFile(file: File): Promise<{ secret: DocMeta; cipher: Uint8Array }> {
  const bytes = await fileBytes(file);
  return encryptBytes(bytes, { filename: file.name, mime: file.type || 'application/octet-stream', size: file.size });
}

export async function decryptBytes(secret: DocMeta, cipher: Uint8Array): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', ab(b64decode(secret.fileKey)), { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: ab(b64decode(secret.fileIv)) }, key, ab(cipher));
  return new Uint8Array(pt);
}

export async function decryptFile(secret: DocMeta, cipher: Uint8Array): Promise<Blob> {
  const bytes = await decryptBytes(secret, cipher);
  return new Blob([bytes as BlobPart], { type: secret.mime });
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
