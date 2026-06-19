import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvExport, parseBitwardenJson, parseExport, recordToItem } from './import';

describe('CSV parsing', () => {
  it('handles quotes, commas and newlines inside fields', () => {
    const rows = parseCsv('name,url,note\n"Gmail","mail.google.com","line1\nline2, with comma"\n');
    expect(rows).toHaveLength(2);
    expect(rows[1][2]).toBe('line1\nline2, with comma');
  });

  it('maps a generic CSV to login records', () => {
    const recs = parseCsvExport('name,url,username,password\nGitHub,github.com,octocat,hunter2\n');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ type: 'login', title: 'GitHub', website: 'github.com', username: 'octocat', password: 'hunter2' });
  });
});

describe('Bitwarden JSON', () => {
  it('maps logins and secure notes', () => {
    const json = JSON.stringify({
      items: [
        { name: 'Gmail', login: { username: 'me', password: 'p', uris: [{ uri: 'mail.google.com' }], totp: 'ABC' }, notes: 'main' },
        { name: 'Wifi codes', type: 2, secureNote: {}, notes: 'the codes' },
      ],
    });
    const recs = parseBitwardenJson(json);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ type: 'login', title: 'Gmail', username: 'me', password: 'p', website: 'mail.google.com', totp: 'ABC' });
    expect(recs[1]).toMatchObject({ type: 'note', title: 'Wifi codes', notes: 'the codes' });
  });
});

describe('parseExport autodetect + recordToItem', () => {
  it('detects JSON vs CSV and never puts the password in metadata', () => {
    const recs = parseExport('export.json', JSON.stringify({ items: [{ name: 'X', login: { username: 'u', password: 'SECRET' } }] }));
    const { type, metadata, secret } = recordToItem(recs[0]);
    expect(type).toBe('login');
    expect(Object.values(metadata)).not.toContain('SECRET');
    expect(secret.password).toBe('SECRET');
    expect(metadata.tags).toBe('imported');
  });

  it('maps an imported note to the note type secret', () => {
    const { type, secret } = recordToItem({ type: 'note', title: 'N', notes: 'body' });
    expect(type).toBe('note');
    expect(secret.content).toBe('body');
  });
});
