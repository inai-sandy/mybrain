// Parse password-manager exports into normalized records, ENTIRELY in the browser. Each record is
// then encrypted before it ever leaves the device. Supports Bitwarden JSON, 1Password/generic CSV.
export type ImportRecord = {
  type: string; // we map everything to 'login' or 'note'
  title: string;
  website?: string;
  username?: string;
  password?: string;
  totp?: string;
  notes?: string;
};

// --- tiny CSV parser (handles quoted fields, commas, escaped quotes, CRLF) ---
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
  }
  return rows;
}

const pick = (h: string[], row: string[], names: string[]): string => {
  for (const n of names) {
    const i = h.indexOf(n);
    if (i >= 0 && row[i]) return row[i];
  }
  return '';
};

export function parseCsvExport(text: string): ImportRecord[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row) => ({
    type: 'login',
    title: pick(header, row, ['name', 'title', 'item', 'account']) || pick(header, row, ['url', 'login_uri', 'website']) || 'Imported login',
    website: pick(header, row, ['url', 'login_uri', 'website', 'urls']),
    username: pick(header, row, ['username', 'login_username', 'user', 'email']),
    password: pick(header, row, ['password', 'login_password', 'pass']),
    totp: pick(header, row, ['otpauth', 'totp', 'login_totp', '2fa']),
    notes: pick(header, row, ['notes', 'note', 'comments']),
  })).filter((r) => r.username || r.password || r.notes);
}

export function parseBitwardenJson(text: string): ImportRecord[] {
  const data = JSON.parse(text);
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  return items
    .map((it): ImportRecord | null => {
      if (it.login) {
        return {
          type: 'login',
          title: it.name || 'Imported login',
          website: it.login.uris?.[0]?.uri || '',
          username: it.login.username || '',
          password: it.login.password || '',
          totp: it.login.totp || '',
          notes: it.notes || '',
        };
      }
      if (it.type === 2 || it.secureNote) {
        return { type: 'note', title: it.name || 'Imported note', notes: it.notes || '' };
      }
      return null;
    })
    .filter((r): r is ImportRecord => !!r);
}

/** Auto-detect the format from the file name + contents. */
export function parseExport(filename: string, text: string): ImportRecord[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json') || text.trimStart().startsWith('{')) {
    try {
      return parseBitwardenJson(text);
    } catch {
      return [];
    }
  }
  return parseCsvExport(text);
}

/** Turn an import record into the (metadata, secret) we store. */
export function recordToItem(rec: ImportRecord): { type: string; metadata: Record<string, string | null>; secret: Record<string, string> } {
  if (rec.type === 'note') {
    return { type: 'note', metadata: { title: rec.title || 'Imported note', website: null, username: null, tags: 'imported', cardType: null, bankName: null }, secret: { content: rec.notes || '' } };
  }
  const secret: Record<string, string> = {};
  if (rec.password) secret.password = rec.password;
  if (rec.totp) secret.totp = rec.totp;
  if (rec.notes) secret.notes = rec.notes;
  return {
    type: 'login',
    metadata: { title: rec.title || 'Imported login', website: rec.website || null, username: rec.username || null, tags: 'imported', cardType: null, bankName: null },
    secret,
  };
}
