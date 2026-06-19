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
};

export type VaultType = {
  type: string;
  label: string;
  icon: LucideIcon;
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
    fields: [
      { key: 'title', label: 'Name', meta: 'title', placeholder: 'e.g. Gmail' },
      { key: 'website', label: 'Website / URL', meta: 'website', kind: 'url', placeholder: 'mail.google.com' },
      { key: 'username', label: 'Username / email', meta: 'username', placeholder: 'you@example.com' },
      { key: 'password', label: 'Password', kind: 'password', generate: true },
      { key: 'totp', label: '2FA / TOTP secret', kind: 'text', placeholder: 'optional' },
      { key: 'notes', label: 'Notes', kind: 'textarea', placeholder: 'optional' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
  },
  {
    type: 'note',
    label: 'Secure note',
    icon: StickyNote,
    fields: [
      { key: 'title', label: 'Title', meta: 'title', placeholder: 'e.g. Door codes' },
      { key: 'content', label: 'Note', kind: 'textarea', placeholder: 'anything private…' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
  },
  {
    type: 'card',
    label: 'Payment card',
    icon: CreditCard,
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. HDFC Credit Card' },
      { key: 'cardType', label: 'Card type', meta: 'cardType', placeholder: 'Visa, Mastercard, Amex…' },
      { key: 'bank', label: 'Bank', meta: 'bankName', placeholder: 'issuing bank' },
      { key: 'cardholder', label: 'Cardholder name', kind: 'text' },
      { key: 'number', label: 'Card number', kind: 'text' },
      { key: 'expiry', label: 'Expiry (MM/YY)', kind: 'text' },
      { key: 'cvv', label: 'CVV', kind: 'password' },
      { key: 'pin', label: 'PIN', kind: 'password' },
      { key: 'billing', label: 'Billing address', kind: 'textarea' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
    // Store only the last 4 digits as searchable metadata so the list can show "Visa •••• 1234" without decrypting.
    deriveMeta: (secret) => ({ username: secret.number ? secret.number.replace(/\D/g, '').slice(-4) || null : null }),
    subtitle: (item) => [item.cardType, item.username ? `•••• ${item.username}` : ''].filter(Boolean).join(' '),
  },
  {
    type: 'bank',
    label: 'Bank account',
    icon: Landmark,
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. HDFC Savings' },
      { key: 'bank', label: 'Bank name', meta: 'bankName', placeholder: 'issuing bank' },
      { key: 'holder', label: 'Account holder', kind: 'text' },
      { key: 'number', label: 'Account number', kind: 'password' },
      { key: 'ifsc', label: 'IFSC / IBAN / routing', kind: 'text' },
      { key: 'accountType', label: 'Account type', kind: 'text', placeholder: 'savings / current' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
    deriveMeta: (secret) => ({ username: secret.number ? secret.number.replace(/\s/g, '').slice(-4) || null : null }),
    subtitle: (item) => [item.bankName, item.username ? `•••• ${item.username}` : ''].filter(Boolean).join(' '),
  },
  {
    type: 'crypto',
    label: 'Crypto wallet',
    icon: Bitcoin,
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Ledger ETH' },
      { key: 'network', label: 'Network', kind: 'text', placeholder: 'BTC, ETH, Solana…' },
      { key: 'wallet', label: 'Wallet', kind: 'text', placeholder: 'Metamask, Ledger…' },
      { key: 'address', label: 'Public address', kind: 'text' },
      { key: 'seed', label: 'Seed phrase', kind: 'textarea', reauth: true },
      { key: 'privateKey', label: 'Private key', kind: 'password', reauth: true },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
  },
  {
    type: 'identity',
    label: 'Identity',
    icon: IdCard,
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Passport' },
      { key: 'fullName', label: 'Full name', kind: 'text' },
      { key: 'dob', label: 'Date of birth', kind: 'text', placeholder: 'DD/MM/YYYY' },
      { key: 'passport', label: 'Passport no', kind: 'text' },
      { key: 'license', label: "Driver's license", kind: 'text' },
      { key: 'govId', label: 'Aadhaar / PAN / national ID', kind: 'password' },
      { key: 'address', label: 'Address', kind: 'textarea' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
  },
  {
    type: 'apisecret',
    label: 'API secret',
    icon: Terminal,
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. OpenAI prod key' },
      { key: 'service', label: 'Service', meta: 'username', placeholder: 'OpenAI, AWS…' },
      { key: 'key', label: 'Key / client ID', kind: 'text' },
      { key: 'secret', label: 'Secret', kind: 'password' },
      { key: 'environment', label: 'Environment', kind: 'text', placeholder: 'prod / dev' },
      { key: 'expiry', label: 'Expiry', kind: 'text', placeholder: 'optional' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
    subtitle: (item) => item.username || '',
  },
  {
    type: 'document',
    label: 'Document',
    icon: FileText,
    file: true,
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Passport scan' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
  },
  {
    type: 'license',
    label: 'Software license',
    icon: BadgeCheck,
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Photoshop' },
      { key: 'product', label: 'Product', meta: 'username', placeholder: 'product name' },
      { key: 'key', label: 'License key', kind: 'password' },
      { key: 'email', label: 'Registered email', kind: 'text' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
  },
  {
    type: 'wifi',
    label: 'Wi-Fi',
    icon: Wifi,
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Home Wi-Fi' },
      { key: 'ssid', label: 'Network (SSID)', meta: 'username', placeholder: 'network name' },
      { key: 'password', label: 'Password', kind: 'password', generate: true },
      { key: 'security', label: 'Security', kind: 'text', placeholder: 'WPA2, WPA3…' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
      { key: 'tags', label: 'Tags', meta: 'tags', placeholder: 'comma, separated' },
    ],
  },
  {
    type: 'membership',
    label: 'Membership',
    icon: Ticket,
    fields: [
      { key: 'title', label: 'Label', meta: 'title', placeholder: 'e.g. Gym' },
      { key: 'provider', label: 'Provider', meta: 'username', placeholder: 'provider name' },
      { key: 'number', label: 'Membership number', kind: 'text' },
      { key: 'pin', label: 'PIN', kind: 'password' },
      { key: 'notes', label: 'Notes', kind: 'textarea' },
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
