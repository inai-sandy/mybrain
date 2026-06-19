import { KeyRound, type LucideIcon } from 'lucide-react';
import type { VaultItemDTO } from './client';

// Which searchable metadata column a field maps to. Fields WITHOUT `meta` are secret → encrypted blob.
export type MetaCol = 'title' | 'website' | 'username' | 'tags' | 'cardType' | 'bankName';

export type VaultField = {
  key: string;
  label: string;
  meta?: MetaCol; // present = stored as searchable plaintext; absent = secret (encrypted)
  kind?: 'text' | 'password' | 'textarea' | 'url';
  placeholder?: string;
  reauth?: boolean; // requires re-entering the passphrase to reveal (seed phrases, private keys) — BEA-350
};

export type VaultType = {
  type: string;
  label: string;
  icon: LucideIcon;
  fields: VaultField[];
};

// The Logins type (BEA-348). More types are appended by later issues.
export const VAULT_TYPES: VaultType[] = [
  {
    type: 'login',
    label: 'Login',
    icon: KeyRound,
    fields: [
      { key: 'title', label: 'Name', meta: 'title', placeholder: 'e.g. Gmail' },
      { key: 'website', label: 'Website / URL', meta: 'website', kind: 'url', placeholder: 'mail.google.com' },
      { key: 'username', label: 'Username / email', meta: 'username', placeholder: 'you@example.com' },
      { key: 'password', label: 'Password', kind: 'password' },
      { key: 'totp', label: '2FA / TOTP secret', kind: 'text', placeholder: 'optional' },
      { key: 'notes', label: 'Notes', kind: 'textarea', placeholder: 'optional' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
  },
];

export const COLLECTIONS = ['Personal', 'Work', 'Beakn', 'Family'] as const;

export function typeDef(type: string): VaultType {
  return VAULT_TYPES.find((v) => v.type === type) || VAULT_TYPES[0];
}

export type FormValues = Record<string, string> & { collection?: string };

/** Split a flat form into (searchable metadata, secret payload) for storage. */
export function splitForm(def: VaultType, values: FormValues): { metadata: Record<string, string | null>; secret: Record<string, string> } {
  const metadata: Record<string, string | null> = { title: null, website: null, username: null, tags: null, cardType: null, bankName: null };
  const secret: Record<string, string> = {};
  for (const f of def.fields) {
    const v = (values[f.key] ?? '').trim();
    if (f.meta) metadata[f.meta] = v || null;
    else if (v) secret[f.key] = v;
  }
  return { metadata, secret };
}

/** Rebuild a flat form from an item's metadata columns + its decrypted secret. */
export function mergeForm(def: VaultType, item: VaultItemDTO, secret: Record<string, string>): FormValues {
  const values: FormValues = { collection: item.collection || '' };
  for (const f of def.fields) {
    if (f.meta) values[f.key] = (item[f.meta] as string) || '';
    else values[f.key] = secret[f.key] || '';
  }
  return values;
}

/** A short subtitle for the list card — first available metadata, never a secret. */
export function itemSubtitle(item: VaultItemDTO): string {
  return item.username || item.website || item.bankName || item.cardType || '';
}
