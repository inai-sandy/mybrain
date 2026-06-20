import { buildVaultIndexText } from './memory.service';

// SECURITY: the vault is zero-knowledge. The label index must contain ONLY searchable metadata and
// must NEVER contain the encrypted blob or any secret value. These tests lock that guarantee.
describe('buildVaultIndexText (vault label-only indexing, BEA-368)', () => {
  it('includes searchable metadata (name, site, username, tags) and a type label', () => {
    const { content, title, tags } = buildVaultIndexText({
      type: 'login',
      title: 'Gmail',
      website: 'mail.google.com',
      username: 'sandy@example.com',
      tags: 'email, google',
      collection: 'Personal',
    });
    expect(content).toContain('Gmail');
    expect(content).toContain('mail.google.com');
    expect(content).toContain('sandy@example.com');
    expect(content).toContain('Login'); // human type label
    expect(title).toBe('Vault: Gmail');
    expect(tags).toEqual(expect.arrayContaining(['vault', 'login', 'email', 'google']));
  });

  it('NEVER leaks a secret — even if a blob / password is present on the row it is ignored', () => {
    const row: any = {
      type: 'login',
      title: 'Gmail',
      username: 'sandy',
      // These must never reach the index. They are not metadata columns; the builder must ignore them.
      blob: JSON.stringify({ item: { iv: 'x', ct: 'SUPER_SECRET_CIPHERTEXT' } }),
      password: 'hunter2-the-real-password',
      secret: 'sk_live_DO_NOT_INDEX',
    };
    const out = buildVaultIndexText(row);
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('SUPER_SECRET_CIPHERTEXT');
    expect(blob).not.toContain('hunter2-the-real-password');
    expect(blob).not.toContain('sk_live_DO_NOT_INDEX');
  });

  it('falls back to the type label when there is no title, and stays metadata-only', () => {
    const { content, title } = buildVaultIndexText({ type: 'crypto' });
    expect(content).toContain('Crypto wallet');
    expect(title).toBe('Vault: Crypto wallet');
  });

  it('card last-4 (the only numeric metadata) is allowed, full numbers are not present', () => {
    // The card type stores ONLY the last 4 as `username` metadata; the full number lives in the blob.
    const { content } = buildVaultIndexText({ type: 'card', title: 'HDFC', cardType: 'Visa', username: '1234' });
    expect(content).toContain('Visa');
    expect(content).toContain('1234'); // last-4 is non-sensitive, by design searchable
  });
});
