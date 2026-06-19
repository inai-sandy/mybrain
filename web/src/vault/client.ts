// Thin typed wrappers over the vault API. Everything sent here is ciphertext / public KDF params.
import type { Cipher, KdfParams, EncryptedBlob } from './crypto';

export type VaultMeta =
  | { setup: false }
  | { setup: true; kdfParams: KdfParams; salt: string; verifier: Cipher; wrapPass: Cipher; wrapRecovery: Cipher; createdAt: string };

export type VaultItemDTO = {
  id: string;
  type: string;
  blob: EncryptedBlob;
  title: string | null;
  website: string | null;
  username: string | null;
  tags: string | null;
  cardType: string | null;
  bankName: string | null;
  collection: string | null;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
};

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || `Request failed (${r.status})`);
  return r.json();
}

export const vaultApi = {
  getMeta: () => fetch('/api/vault/meta').then((r) => j<VaultMeta>(r)),

  createMeta: (body: { kdfParams: KdfParams; salt: string; verifier: Cipher; wrapPass: Cipher; wrapRecovery: Cipher }) =>
    fetch('/api/vault/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j(r)),

  rewrap: (body: { salt?: string; kdfParams?: KdfParams; verifier?: Cipher; wrapPass: Cipher; wrapRecovery?: Cipher }) =>
    fetch('/api/vault/meta/rewrap', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j(r)),

  list: (q: Record<string, string | number | boolean | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
    return fetch(`/api/vault/items?${params.toString()}`).then((r) => j<{ items: VaultItemDTO[]; total: number; page: number; pageSize: number }>(r));
  },

  get: (id: string) => fetch(`/api/vault/items/${id}`).then((r) => j<VaultItemDTO>(r)),

  create: (body: Partial<VaultItemDTO> & { type: string; blob: EncryptedBlob }) =>
    fetch('/api/vault/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<VaultItemDTO>(r)),

  update: (id: string, body: Partial<VaultItemDTO>) =>
    fetch(`/api/vault/items/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<VaultItemDTO>(r)),

  remove: (id: string) => fetch(`/api/vault/items/${id}`, { method: 'DELETE' }).then((r) => j(r)),

  count: () => fetch('/api/vault/items/count').then((r) => j<{ count: number }>(r)),

  // Encrypted document attachments (the bytes are already ciphertext).
  uploadFile: (id: string, cipher: Uint8Array) => {
    const fd = new FormData();
    fd.append('file', new Blob([cipher as BlobPart]), 'blob');
    return fetch(`/api/vault/items/${id}/file`, { method: 'POST', body: fd }).then((r) => j(r));
  },
  downloadFile: (id: string) => fetch(`/api/vault/items/${id}/file`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('No file')))),
};
