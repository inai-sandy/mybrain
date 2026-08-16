import { GoogleService } from './google.service';

/**
 * Locks the Drive + Gmail import fixes from BEA-1341.
 *
 * The headline regression: `gws drive files export` returns a RECEIPT, not the document, so the old
 * code stored the string "[object Object]" for every Google Doc. These tests assert we go through
 * the binary path instead, and that the receipt shape can never be mistaken for content again.
 */

type Upload = { originalname: string; mimetype?: string; buffer: Buffer };
type Opts = { collectionId?: string | null; sourceUrl?: string | null };

function fakeLibrary() {
  const saved: { file: Upload; opts?: Opts }[] = [];
  const collections: string[] = [];
  return {
    saved,
    collections,
    findImported: jest.fn(async () => null), // nothing imported before, in these tests
    replaceContent: jest.fn(async (id: string) => ({ id, title: 'refreshed' })),
    refreshFromUpload: jest.fn(async (id: string) => ({ id, title: 'refreshed' })),
    ensureCollection: jest.fn(async (name: string) => {
      collections.push(name);
      return `col-${name.toLowerCase().replace(/\s+/g, '-')}`;
    }),
    createFromUpload: jest.fn(async (file: Upload, opts?: Opts) => {
      saved.push({ file, opts });
      return { id: `doc-${saved.length}`, title: file.originalname.replace(/\.[^.]+$/, '') };
    }),
  };
}

function build() {
  const lib = fakeLibrary();
  const items = { store: jest.fn() } as any;
  const svc = new GoogleService(items, lib as any);
  return { svc, lib, items };
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** What the CLI actually prints for an export — the thing that used to be stored as content. */
const EXPORT_RECEIPT = { bytes: 71877, mimeType: 'text/plain', saved_file: 'download.txt', status: 'success' };

describe('driveImport', () => {
  it('never stores the export receipt as content — the [object Object] bug', async () => {
    const { svc, lib } = build();
    svc.run = jest.fn(async () => ({ name: 'Trading products', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://drive/x' })) as any;
    // If anything ever routes an export through run() again, it gets this receipt back.
    svc.runBinary = jest.fn(async () => Buffer.from('PK real docx bytes')) as any;

    await svc.driveImport('file-1');

    const body = lib.saved[0].file.buffer.toString('utf8');
    expect(body).not.toContain('[object Object]');
    expect(body).not.toContain(String(EXPORT_RECEIPT.saved_file));
    expect(body).toBe('PK real docx bytes');
    expect(svc.runBinary).toHaveBeenCalledTimes(1);
  });

  it('exports a Google Doc as .docx so headings and tables survive', async () => {
    const { svc, lib } = build();
    svc.run = jest.fn(async () => ({ name: 'Quote', mimeType: 'application/vnd.google-apps.document' })) as any;
    svc.runBinary = jest.fn(async () => Buffer.from('x')) as any;

    await svc.driveImport('file-1');

    expect(JSON.stringify((svc.runBinary as jest.Mock).mock.calls[0][0])).toContain(DOCX);
    expect(lib.saved[0].file.originalname).toBe('Quote.docx');
  });

  it('exports a Google Sheet as .xlsx, so every sheet comes through — not just the first', async () => {
    const { svc, lib } = build();
    svc.run = jest.fn(async () => ({ name: 'Prices', mimeType: 'application/vnd.google-apps.spreadsheet' })) as any;
    svc.runBinary = jest.fn(async () => Buffer.from('x')) as any;

    await svc.driveImport('file-1');

    const argv = JSON.stringify((svc.runBinary as jest.Mock).mock.calls[0][0]);
    expect(argv).toContain(XLSX);
    expect(argv).not.toContain('text/csv'); // csv is first-sheet-only
    expect(lib.saved[0].file.originalname).toBe('Prices.xlsx');
  });

  it('exports Google Slides as .pptx', async () => {
    const { svc } = build();
    svc.run = jest.fn(async () => ({ name: 'Deck', mimeType: 'application/vnd.google-apps.presentation' })) as any;
    svc.runBinary = jest.fn(async () => Buffer.from('x')) as any;

    await svc.driveImport('file-1');

    expect(JSON.stringify((svc.runBinary as jest.Mock).mock.calls[0][0])).toContain(PPTX);
  });

  it('downloads a real Office file stored in Drive instead of refusing it', async () => {
    const { svc, lib } = build();
    svc.run = jest.fn(async () => ({ name: 'Vendor Quote.docx', mimeType: DOCX })) as any;
    svc.runBinary = jest.fn(async () => Buffer.from('x')) as any;

    await expect(svc.driveImport('file-1')).resolves.toBeTruthy();

    expect(JSON.stringify((svc.runBinary as jest.Mock).mock.calls[0][0])).toContain('alt');
    expect(lib.saved[0].file.originalname).toBe('Vendor Quote.docx'); // no double extension
  });

  it('files everything from Drive into the Google Drive folder, with a link back', async () => {
    const { svc, lib } = build();
    svc.run = jest.fn(async () => ({ name: 'Quote', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://drive/x' })) as any;
    svc.runBinary = jest.fn(async () => Buffer.from('x')) as any;

    await svc.driveImport('file-1');

    expect(lib.ensureCollection).toHaveBeenCalledWith('Google Drive', expect.anything());
    expect(lib.saved[0].opts?.collectionId).toBe('col-google-drive');
    expect(lib.saved[0].opts?.sourceUrl).toBe('https://drive/x');
  });

  // The refresh branch had no coverage at all, which is how the rename bug survived. (BEA-1344)
  it('refreshes a Drive file that was already imported, instead of making a second copy', async () => {
    const { svc, lib } = build();
    svc.run = jest.fn(async () => ({ name: 'Quote', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://drive/x' })) as any;
    svc.runBinary = jest.fn(async () => Buffer.from('x')) as any;
    lib.findImported = jest.fn(async () => ({ id: 'doc-existing', title: 'Quote' })) as any;

    const res = await svc.driveImport('file-1');

    expect(lib.refreshFromUpload).toHaveBeenCalledWith('doc-existing', expect.objectContaining({ originalname: 'Quote.docx' }));
    expect(lib.createFromUpload).not.toHaveBeenCalled();
    expect(res.id).toBe('doc-existing');
  });

  it('still finds a Drive file that was RENAMED, by matching on its link alone', async () => {
    const { svc, lib } = build();
    svc.run = jest.fn(async () => ({ name: 'Quote v2', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://drive/x' })) as any;
    svc.runBinary = jest.fn(async () => Buffer.from('x')) as any;
    lib.findImported = jest.fn(async () => ({ id: 'doc-existing', title: 'Quote' })) as any;

    await svc.driveImport('file-1');

    // Looked up by link only — passing the (now different) filename would miss and duplicate.
    expect(lib.findImported).toHaveBeenCalledWith('https://drive/x');
    expect(lib.refreshFromUpload).toHaveBeenCalled();
  });

  it('refuses a Drive file that declares itself too big, before downloading it', async () => {
    const { svc } = build();
    svc.run = jest.fn(async () => ({ name: 'huge.bin', mimeType: 'application/octet-stream', size: String(60 * 1024 * 1024) })) as any;
    svc.runBinary = jest.fn() as any;

    await expect(svc.driveImport('file-1')).rejects.toThrow(/too big/i);
    expect(svc.runBinary).not.toHaveBeenCalled(); // never downloaded
  });

  it('says plainly when a Google file has no document form (a Form, a Drawing)', async () => {
    const { svc } = build();
    svc.run = jest.fn(async () => ({ name: 'Survey', mimeType: 'application/vnd.google-apps.form' })) as any;
    svc.runBinary = jest.fn() as any;

    await expect(svc.driveImport('file-1')).rejects.toThrow(/no document to bring in/i);
    expect(svc.runBinary).not.toHaveBeenCalled();
  });

  it('refuses an empty download rather than saving a blank document', async () => {
    const { svc } = build();
    svc.run = jest.fn(async () => ({ name: 'Quote', mimeType: 'application/vnd.google-apps.document' })) as any;
    svc.runBinary = jest.fn(async () => Buffer.alloc(0)) as any;

    await expect(svc.driveImport('file-1')).rejects.toThrow(/empty/i);
  });
});

describe('gmailImport', () => {
  const message = {
    threadId: 'thread-9',
    payload: {
      headers: [
        { name: 'From', value: 'vendor@example.com' },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: 'Quote for 25 boards' },
        { name: 'Date', value: 'Sat, 16 Aug 2026 10:00:00 +0530' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Here is our price.').toString('base64url') } },
        { mimeType: DOCX, filename: 'quote.docx', body: { attachmentId: 'att-1' } },
        // an inline signature logo — must NOT become a document
        { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }], body: { attachmentId: 'att-2' } },
        // Outlook puts a Content-ID on REAL attachments too — this one must still be saved
        { mimeType: 'application/pdf', filename: 'terms.pdf', headers: [{ name: 'Content-ID', value: '<terms>' }, { name: 'Content-Disposition', value: 'attachment; filename="terms.pdf"' }], body: { attachmentId: 'att-3' } },
      ],
    },
  };

  function wire(svc: GoogleService) {
    svc.run = jest.fn(async (argv: string[]) => {
      if (argv.includes('attachments')) return { data: Buffer.from('PK attachment bytes').toString('base64url') };
      if (argv.includes('threads')) return { messages: [{ ...message, id: 'msg-1' }] };
      return message;
    }) as any;
  }

  it('saves the email and its real attachment, and skips the inline logo', async () => {
    const { svc, lib } = build();
    wire(svc);

    const res = await svc.gmailImport('msg-1');

    expect(res.attachments).toBe(2);
    const names = lib.saved.map((s) => s.file.originalname);
    expect(names).toContain('quote.docx');
    expect(names).toContain('terms.pdf'); // a Content-ID does NOT mean inline
    expect(names).not.toContain('logo.png');
  });

  it('keys each attachment on its own id, with a key short enough to store (BEA-1344)', async () => {
    const { svc, lib } = build();
    const longId = 'A'.repeat(400); // real Gmail attachment ids run this long
    svc.run = jest.fn(async (argv: string[]) => {
      if (argv.includes('attachments')) return { data: Buffer.from('bytes').toString('base64url') };
      if (argv.includes('threads')) {
        return { messages: [{ ...message, id: 'msg-1', payload: { ...message.payload, parts: [
          { mimeType: DOCX, filename: 'invoice.pdf', body: { attachmentId: longId + '1' } },
          { mimeType: DOCX, filename: 'invoice.pdf', body: { attachmentId: longId + '2' } },
        ] } } ] };
      }
      return message;
    }) as any;

    const res = await svc.gmailThreadImport('thread-9');

    // Two different files that happen to share a name must BOTH be saved...
    expect(res.attachments).toBe(2);
    // ...and every key must be well inside the 500-char store limit, or they'd truncate into one.
    for (const call of (lib.findImported as jest.Mock).mock.calls) {
      expect(String(call[0]).length).toBeLessThan(200);
    }
  });

  it('puts everything from Gmail in the Email folder', async () => {
    const { svc, lib } = build();
    wire(svc);

    await svc.gmailImport('msg-1');

    expect(lib.ensureCollection).toHaveBeenCalledWith('Email', expect.anything());
    for (const s of lib.saved) expect(s.opts?.collectionId).toBe('col-email');
  });

  it('keeps who it is from, and the body, in the saved email', async () => {
    const { svc, lib } = build();
    wire(svc);

    await svc.gmailImport('msg-1');

    const md = lib.saved[0].file.buffer.toString('utf8');
    expect(md).toContain('# Quote for 25 boards');
    expect(md).toContain('vendor@example.com');
    expect(md).toContain('Here is our price.');
  });

  it('still saves the email when an attachment cannot be fetched', async () => {
    const { svc, lib } = build();
    svc.run = jest.fn(async (argv: string[]) => {
      if (argv.includes('attachments')) throw new Error('attachment gone');
      return message;
    }) as any;

    const res = await svc.gmailImport('msg-1');

    expect(res.attachments).toBe(0);
    expect(lib.saved).toHaveLength(1); // the email itself survived
  });

  it('refreshes the same conversation instead of leaving a second copy', async () => {
    const { svc, lib } = build();
    wire(svc);
    lib.findImported = jest.fn(async (_url: string, filename: string) =>
      filename.endsWith('.md') ? { id: 'doc-existing', title: 'Quote for 25 boards' } : null) as any;

    await svc.gmailThreadImport('thread-9');

    expect(lib.replaceContent).toHaveBeenCalledWith('doc-existing', expect.stringContaining('# Quote for 25 boards'));
    expect(lib.saved.map((s) => s.file.originalname)).not.toContain('Quote for 25 boards.md');
  });

  it('makes a safe filename from a subject with slashes', async () => {
    const { svc, lib } = build();
    svc.run = jest.fn(async () => ({ ...message, payload: { ...message.payload, headers: [{ name: 'Subject', value: 'RFQ 12/08 <urgent>' }], parts: [] } })) as any;

    await svc.gmailImport('msg-1');

    expect(lib.saved[0].file.originalname).not.toMatch(/[\\/<>]/);
  });
});
