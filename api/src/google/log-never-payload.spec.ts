import { build } from './google-workspace.testing';

/**
 * BEA-1353 — the flight recorder must NEVER hold the mail.
 *
 * `summarise()` writes a short account of every Google call into `ToolCall.result`. Its contract is
 * "counts, never the payload". The independent review of BEA-1351 found that when a response had none
 * of the list keys it counts, it fell back to `JSON.stringify(data)` — the raw payload — so a single
 * message fetch (what email memory does every day) wrote the subject, sender and body preview into
 * the log, and an attachment or Drive download wrote its signed download URL.
 *
 * Each case below feeds a real-shaped response and asserts none of the sensitive content is recorded.
 */
const recorded = (prisma: any): string[] =>
  (prisma.toolCall.create as jest.Mock).mock.calls.map((c: any[]) => String(c[0]?.data?.result ?? ''));

describe('the tool-call log never holds the mail (BEA-1353)', () => {
  it('a single message fetch records no subject, sender, snippet or body', async () => {
    const { svc, prisma } = build((id) => {
      if (/fetch_message_by_message_id/i.test(id)) {
        return {
          id: 'm1', threadId: 't1',
          snippet: 'SECRET-SNIPPET the quarterly numbers are',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'Subject', value: 'SECRET-SUBJECT board pack' }, { name: 'From', value: 'ceo@example.com' }],
            body: { data: Buffer.from('SECRET-BODY do not forward').toString('base64url') },
          },
        };
      }
      return {};
    });
    await svc.gmailMessageFull('m1');
    const rows = recorded(prisma);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).not.toMatch(/SECRET-SUBJECT|SECRET-SNIPPET|SECRET-BODY|ceo@example\.com|board pack/);
      expect(r).not.toMatch(/"payload"|"headers"/);
    }
  });

  it('an attachment or Drive download records no signed URL', async () => {
    const { svc, prisma } = build((id) => {
      if (/fetch_message_by_message_id/i.test(id)) {
        return { id: 'm2', threadId: 't2', payload: { mimeType: 'multipart/mixed', headers: [], parts: [
          { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'att-1', size: 3 } },
        ] } };
      }
      if (/get_attachment/i.test(id)) return { file: { name: 'invoice.pdf', s3url: 'https://signed.example.com/SECRET-URL-TOKEN?sig=abc' } };
      return {};
    });
    // The import path fetches the message, then its attachment bytes.
    const stopServing = (await import('./google-workspace.testing')).serveBytes({ 'signed.example.com': Buffer.from('pdf') });
    try {
      await svc.gmailImport('m2').catch(() => undefined);
    } finally { stopServing(); }
    for (const r of recorded(prisma)) {
      expect(r).not.toMatch(/SECRET-URL-TOKEN|s3url|https:\/\//);
    }
  });

  it('a list response still records the count as before', async () => {
    const { svc, prisma } = build((id) => (/fetch_emails/i.test(id) ? { messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } : {}));
    await svc.gmailList('is:unread').catch(() => undefined);
    const rows = recorded(prisma);
    expect(rows.some((r) => /3 messages/.test(r))).toBe(true);
  });
});
