import { KeyRound, StickyNote, CreditCard, Landmark, Bitcoin, IdCard, Terminal, FileText, BadgeCheck, Wifi, Ticket, type LucideIcon } from 'lucide-react';
import type { VaultItemDTO } from './client';

// Which searchable metadata column a field maps to. Fields WITHOUT `meta` are secret → encrypted blob.
export type MetaCol = 'title' | 'website' | 'username' | 'tags' | 'cardType' | 'bankName';

export type VaultField = {
  key: string;
  label: string;
  meta?: MetaCol; // present = stored as searchable plaintext; absent = secret (encrypted)
  kind?: 'text' | 'password' | 'textarea' | 'url';
  placeholder?: string;
  generate?: boolean; // show the password generator on this field
  reauth?: boolean; // requires re-entering the passphrase to reveal (seed phrases, private keys) — BEA-350
  section?: string; // group fields under a section header in the editor (BEA-366). `title` is always rendered first, unsectioned.
};

export type VaultType = {
  type: string;
  label: string;
  icon: LucideIcon;
  hint?: string; // one-line description shown in the type chooser (BEA-366)
  group?: string; // which group the type chooser files this under (BEA-366)
  fields: VaultField[];
  file?: boolean; // this type carries an encrypted file attachment (Secure documents)
  // Optional: derive extra searchable metadata from the secret (e.g. a card's last-4) — never a full secret.
  deriveMeta?: (secret: Record<string, string>) => Partial<Record<MetaCol, string | null>>;
  // Optional: a safe one-line subtitle for the list card (metadata only).
  subtitle?: (item: VaultItemDTO) => string;
};

export const VAULT_TYPES: VaultType[] = [
  {
    type: 'login',
    label: 'Login',
    icon: KeyRound,
    hint: 'Website or app password',
    group: 'Logins & access',
    fields: [
      { key: 'title', label: 'Name', meta: 'title', placeholder: 'e.g. Gmail' },
      { key: 'website', label: 'Website / URL', meta: 'website', kind: 'url', placeholder: 'mail.google.com', section: 'Account' },
      { key: 'username', label: 'Username / email', meta: 'username', placeholder: 'you@example.com', section: 'Account' },
      { key: 'password', label: 'Password', kind: 'password', generate: true, section: 'Sign-in secret' },
      { key: 'totp', label: '2FA / TOTP secret', kind: 'text', placeholder: 'optional', section: 'Sign-in secret' },
      { key: 'notes', label: 'Notes', kind: 'textarea', placeholder: 'optional', section: 'Notes & tags' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
  },
  {
    type: 'note',
    label: 'Secure note',
    icon: StickyNote,
    hint: 'Free-form private text',
    group: 'Notes & files',
    fields: [
      { key: 'title', label: 'Title', meta: 'title', placeholder: 'e.g. Door codes' },
      { key: 'content', label: 'Note', kind: 'textarea', placeholder: 'anything private…' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
  },
  {
    type: 'card',
    label: 'Payment card',
    icon: CreditCard,
    hint: 'Credit / debit card',
    group: 'Finance',
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. HDFC Credit Card' },
      { key: 'cardType', label: 'Card type', meta: 'cardType', placeholder: 'Visa, Mastercard, Amex…', section: 'Card details' },
      { key: 'bank', label: 'Bank', meta: 'bankName', placeholder: 'issuing bank', section: 'Card details' },
      { key: 'cardholder', label: 'Cardholder name', kind: 'text', section: 'Card details' },
      { key: 'number', label: 'Card number', kind: 'text', section: 'Card details' },
      { key: 'expiry', label: 'Expiry (MM/YY)', kind: 'text', section: 'Card details' },
      { key: 'cvv', label: 'CVV', kind: 'password', section: 'Security' },
      { key: 'pin', label: 'PIN', kind: 'password', section: 'Security' },
      { key: 'billing', label: 'Billing address', kind: 'textarea', section: 'Billing' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
    // Store only the last 4 digits as searchable metadata so the list can show "Visa •••• 1234" without decrypting.
    deriveMeta: (secret) => ({ username: secret.number ? secret.number.replace(/\D/g, '').slice(-4) || null : null }),
    subtitle: (item) => [item.cardType, item.username ? `•••• ${item.username}` : ''].filter(Boolean).join(' '),
  },
  {
    type: 'bank',
    label: 'Bank account',
    icon: Landmark,
    hint: 'Account & IFSC / IBAN',
    group: 'Finance',
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. HDFC Savings' },
      { key: 'bank', label: 'Bank name', meta: 'bankName', placeholder: 'issuing bank', section: 'Account' },
      { key: 'holder', label: 'Account holder', kind: 'text', section: 'Account' },
      { key: 'number', label: 'Account number', kind: 'password', section: 'Account' },
      { key: 'ifsc', label: 'IFSC / IBAN / routing', kind: 'text', section: 'Account' },
      { key: 'accountType', label: 'Account type', kind: 'text', placeholder: 'savings / current', section: 'Account' },
      { key: 'notes', label: 'Notes', kind: 'textarea', section: 'Notes & tags' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
    deriveMeta: (secret) => ({ username: secret.number ? secret.number.replace(/\s/g, '').slice(-4) || null : null }),
    subtitle: (item) => [item.bankName, item.username ? `•••• ${item.username}` : ''].filter(Boolean).join(' '),
  },
  {
    type: 'crypto',
    label: 'Crypto wallet',
    icon: Bitcoin,
    hint: 'Wallet, seed & keys',
    group: 'Finance',
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Ledger ETH' },
      { key: 'network', label: 'Network', kind: 'text', placeholder: 'BTC, ETH, Solana…', section: 'Wallet' },
      { key: 'wallet', label: 'Wallet', kind: 'text', placeholder: 'Metamask, Ledger…', section: 'Wallet' },
      { key: 'address', label: 'Public address', kind: 'text', section: 'Wallet' },
      { key: 'seed', label: 'Seed phrase', kind: 'textarea', reauth: true, section: 'Sensitive keys' },
      { key: 'privateKey', label: 'Private key', kind: 'password', reauth: true, section: 'Sensitive keys' },
      { key: 'notes', label: 'Notes', kind: 'textarea', section: 'Notes & tags' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
  },
  {
    type: 'identity',
    label: 'Identity',
    icon: IdCard,
    hint: 'Passport, ID & personal',
    group: 'Identity & keys',
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Passport' },
      { key: 'fullName', label: 'Full name', kind: 'text', section: 'Personal' },
      { key: 'dob', label: 'Date of birth', kind: 'text', placeholder: 'DD/MM/YYYY', section: 'Personal' },
      { key: 'address', label: 'Address', kind: 'textarea', section: 'Personal' },
      { key: 'passport', label: 'Passport no', kind: 'text', section: 'Documents' },
      { key: 'license', label: "Driver's license", kind: 'text', section: 'Documents' },
      { key: 'govId', label: 'Aadhaar / PAN / national ID', kind: 'password', section: 'Documents' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
  },
  {
    type: 'apisecret',
    label: 'API secret',
    icon: Terminal,
    hint: 'API key / client secret',
    group: 'Identity & keys',
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. OpenAI prod key' },
      { key: 'service', label: 'Service', meta: 'username', placeholder: 'OpenAI, AWS…', section: 'Credentials' },
      { key: 'key', label: 'Key / client ID', kind: 'text', section: 'Credentials' },
      { key: 'secret', label: 'Secret', kind: 'password', section: 'Credentials' },
      { key: 'environment', label: 'Environment', kind: 'text', placeholder: 'prod / dev', section: 'Credentials' },
      { key: 'expiry', label: 'Expiry', kind: 'text', placeholder: 'optional', section: 'Credentials' },
      { key: 'notes', label: 'Notes', kind: 'textarea', section: 'Notes & tags' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
    subtitle: (item) => item.username || '',
  },
  {
    type: 'document',
    label: 'Document',
    icon: FileText,
    hint: 'Encrypted file attachment',
    group: 'Notes & files',
    file: true,
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Passport scan' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
  },
  {
    type: 'license',
    label: 'Software license',
    icon: BadgeCheck,
    hint: 'Product key & email',
    group: 'Identity & keys',
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Photoshop' },
      { key: 'product', label: 'Product', meta: 'username', placeholder: 'product name', section: 'License' },
      { key: 'key', label: 'License key', kind: 'password', section: 'License' },
      { key: 'email', label: 'Registered email', kind: 'text', section: 'License' },
      { key: 'notes', label: 'Notes', kind: 'textarea', section: 'Notes & tags' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
  },
  {
    type: 'wifi',
    label: 'Wi-Fi',
    icon: Wifi,
    hint: 'Network & password',
    group: 'Logins & access',
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Home Wi-Fi' },
      { key: 'ssid', label: 'Network (SSID)', meta: 'username', placeholder: 'network name', section: 'Network' },
      { key: 'password', label: 'Password', kind: 'password', generate: true, section: 'Network' },
      { key: 'security', label: 'Security', kind: 'text', placeholder: 'WPA2, WPA3…', section: 'Network' },
      { key: 'notes', label: 'Notes', kind: 'textarea', section: 'Notes & tags' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
  },
  {
    type: 'membership',
    label: 'Membership',
    icon: Ticket,
    hint: 'Card number & PIN',
    group: 'Logins & access',
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Gym' },
      { key: 'provider', label: 'Provider', meta: 'username', placeholder: 'provider name', section: 'Membership' },
      { key: 'number', label: 'Membership number', kind: 'text', section: 'Membership' },
      { key: 'pin', label: 'PIN', kind: 'password', section: 'Membership' },
      { key: 'notes', label: 'Notes', kind: 'textarea', section: 'Notes & tags' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated', section: 'Notes & tags' },
    ],
  },
];

export const COLLECTIONS = ['Personal', 'Work', 'Beakn', 'Family'] as const;

// Type chooser layout (BEA-366): the order of groups, and the order of types within each.
export const TYPE_GROUP_ORDER = ['Logins & access', 'Finance', 'Identity & keys', 'Notes & files'] as const;

export const VAULT_GROUPS: { label: string; types: VaultType[] }[] = TYPE_GROUP_ORDER.map((g) => ({
  label: g,
  types: VAULT_TYPES.filter((t) => (t.group || 'Notes & files') === g),
}));

/** Fields grouped into sections for the editor. `title` (the name) is always returned first, unsectioned. */
export function sectionedFields(def: VaultType): { section: string | null; fields: VaultField[] }[] {
  const out: { section: string | null; fields: VaultField[] }[] = [];
  for (const f of def.fields) {
    const section = f.key === 'title' ? null : f.section || null;
    const last = out[out.length - 1];
    if (last && last.section === section) last.fields.push(f);
    else out.push({ section, fields: [f] });
  }
  return out;
}

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
  if (def.deriveMeta) Object.assign(metadata, def.deriveMeta(secret));
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

/** A short subtitle for the list card — metadata only, never a secret. */
export function itemSubtitle(item: VaultItemDTO): string {
  const def = typeDef(item.type);
  if (def.subtitle) return def.subtitle(item);
  return item.username || item.website || item.bankName || '';
}
