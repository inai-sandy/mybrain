import { build, calls, DOCX, PPTX, serveBytes, XLSX } from './google-workspace.testing';

/**
 * Locks the Drive + Gmail import fixes from BEA-1341 / 1343 / 1344 — now through the ServiceProvider
 * seam (BEA-1351). Same intent and the same fixtures as when these ran against the gws bridge; only
 * the transport is asserted differently. The bridge's headline regression was `gws drive files
 * export` returning a RECEIPT, not the document, so every Google Doc import stored the string
 * "[object Object]" — the seam has its own version of that trap: binary content is not in the answer
 * at all, but behind a short-lived download link, so the first test still asks "did the real bytes
 * get stored?".
 */

// ---- Drive ---------------------------------------------------------------------------------

describe('driveImport (through the seam)', () => {
  let restore: () => void;
  beforeEach(() => { restore = serveBytes({ 'stage/export': Buffer.from('PK real docx bytes'), 'stage/plain': Buffer.from('x') }); });
  afterEach(() => restore());

  const drive = (meta: any, link?: string) => (id: string, args: any) => {
    if (id === 'svc:googledrive.get_file_metadata') return meta;
    if (id === 'svc:googledrive.find_file') return { files: [{ id: 'file-1', ...meta, webViewLink: link }] };
    if (id === 'svc:googledrive.download_file') return { downloaded_file_content: { name: meta.name, mimetype: args.mime_type || meta.mimeType, s3url: args.mime_type ? 'https://x/stage/export' : 'https://x/stage/plain' } };
    return {};
  };

  it('stores the real exported bytes, never a receipt or a link (the [object Object] bug)', async () => {
    const { svc, lib } = build(drive({ name: 'Trading products', mimeType: 'application/vnd.google-apps.document' }, 'https://drive/x'));
    await svc.driveImport('file-1');
    const body = lib.saved[0].file.buffer.toString('utf8');
    expect(body).toBe('PK real docx bytes');
    expect(body).not.toContain('[object Object]');
    expect(body).not.toContain('https://');
  });

  it('exports a Google Doc as .docx so headings and tables survive', async () => {
    const { svc, lib, provider } = build(drive({ name: 'Quote', mimeType: 'application/vnd.google-apps.document' }));
    await svc.driveImport('file-1');
    const dl = calls(provider).find((c) => c.id === 'svc:googledrive.download_file');
    expect(dl.args).toEqual({ file_id: 'file-1', mime_type: DOCX });
    expect(lib.saved[0].file.originalname).toBe('Quote.docx');
  });

  it('exports a Google Sheet as .xlsx, so every sheet comes through — not just the first', async () => {
    const { svc, lib, provider } = build(drive({ name: 'Prices', mimeType: 'application/vnd.google-apps.spreadsheet' }));
    await svc.driveImport('file-1');
    const dl = calls(provider).find((c) => c.id === 'svc:googledrive.download_file');
    expect(dl.args.mime_type).toBe(XLSX);
    expect(dl.args.mime_type).not.toContain('csv'); // csv is first-sheet-only
    expect(lib.saved[0].file.originalname).toBe('Prices.xlsx');
  });

  it('exports Google Slides as .pptx', async () => {
    const { svc, provider } = build(drive({ name: 'Deck', mimeType: 'application/vnd.google-apps.presentation' }));
    await svc.driveImport('file-1');
    expect(calls(provider).find((c) => c.id === 'svc:googledrive.download_file').args.mime_type).toBe(PPTX);
  });

  it('downloads a real Office file stored in Drive as-is, with no export and no double extension', async () => {
    const { svc, lib, provider } = build(drive({ name: 'Vendor Quote.docx', mimeType: DOCX }));
    await expect(svc.driveImport('file-1')).resolves.toBeTruthy();
    const dl = calls(provider).find((c) => c.id === 'svc:googledrive.download_file');
    expect(dl.args).toEqual({ file_id: 'file-1' }); // native format — no mime_type
    expect(lib.saved[0].file.originalname).toBe('Vendor Quote.docx');
  });

  it('gives a binary call the long timeout — a Drive export takes longer than an API call', async () => {
    const { svc, provider } = build(drive({ name: 'Deck', mimeType: 'application/vnd.google-apps.presentation' }));
    await svc.driveImport('file-1');
    const dl = calls(provider).find((c) => c.id === 'svc:googledrive.download_file');
    expect(dl.opts.timeoutMs).toBeGreaterThan(20_000);
    expect(dl.opts.connectionId).toBe('ca_googledrive');
  });

  it('files everything from Drive into the Google Drive folder, with the link back as the dedupe key', async () => {
    const { svc, lib } = build(drive({ name: 'Quote', mimeType: 'application/vnd.google-apps.document' }, 'https://drive/x'));
    await svc.driveImport('file-1');
    expect(lib.ensureCollection).toHaveBeenCalledWith('Google Drive', expect.anything());
    expect(lib.saved[0].opts?.collectionId).toBe('col-google-drive');
    expect(lib.saved[0].opts?.sourceUrl).toBe('https://drive/x');
  });

  it('finds the link by a second by-name search, because the metadata action does not return it', async () => {
    const { svc, provider } = build(drive({ name: "Sandy's Quote", mimeType: 'application/vnd.google-apps.document' }, 'https://drive/x'));
    await svc.driveImport('file-1');
    const find = calls(provider).find((c) => c.id === 'svc:googledrive.find_file');
    expect(find.args.q).toBe("name = 'Sandy\\'s Quote'"); // escaped for Drive's query language
  });

  it('refreshes a Drive file that was already imported, instead of making a second copy (BEA-1344)', async () => {
    const { svc, lib } = build(drive({ name: 'Quote', mimeType: 'application/vnd.google-apps.document' }, 'https://drive/x'));
    lib.findImported = jest.fn(async () => ({ id: 'doc-existing', title: 'Quote' })) as any;
    const res = await svc.driveImport('file-1');
    expect(lib.findImported).toHaveBeenCalledWith('https://drive/x'); // link alone — survives a rename
    expect(lib.refreshFromUpload).toHaveBeenCalledWith('doc-existing', expect.objectContaining({ originalname: 'Quote.docx' }));
    expect(lib.createFromUpload).not.toHaveBeenCalled();
    expect(res.id).toBe('doc-existing');
  });

  it('refuses a Drive file that declares itself too big, before downloading it', async () => {
    const answer = (id: string) => (id === 'svc:googledrive.get_file_metadata' ? { name: 'huge.bin', mimeType: 'application/octet-stream' } : id === 'svc:googledrive.find_file' ? { files: [{ id: 'file-1', name: 'huge.bin', size: String(60 * 1024 * 1024) }] } : {});
    const { svc, provider } = build(answer);
    await expect(svc.driveImport('file-1')).rejects.toThrow(/too big/i);
    expect(calls(provider).some((c) => c.id === 'svc:googledrive.download_file')).toBe(false);
  });

  it('says plainly when a Google file has no document form (a Form, a Drawing)', async () => {
    const { svc, provider } = build(drive({ name: 'Survey', mimeType: 'application/vnd.google-apps.form' }));
    await expect(svc.driveImport('file-1')).rejects.toThrow(/no document to bring in/i);
    expect(calls(provider).some((c) => c.id === 'svc:googledrive.download_file')).toBe(false);
  });

  it('refuses an empty download rather than saving a blank document', async () => {
    restore();
    restore = serveBytes({ 'stage/export': Buffer.alloc(0) });
    const { svc } = build(drive({ name: 'Quote', mimeType: 'application/vnd.google-apps.document' }));
    await expect(svc.driveImport('file-1')).rejects.toThrow(/empty/i);
  });

  it('lists Drive with the same query the bridge used, and reads files from the answer', async () => {
    const { svc, provider } = build((id) => (id === 'svc:googledrive.find_file' ? { files: [{ id: 'f', name: 'A', mimeType: 'application/pdf', modifiedTime: 't', webViewLink: 'l' }] } : {}));
    const out = await svc.driveList('quote');
    expect(out).toEqual([{ id: 'f', name: 'A', mimeType: 'application/pdf', modified: 't', link: 'l' }]);
    expect(calls(provider)[0].args.q).toBe("name contains 'quote' and trashed=false");
  });
});

// ---- Gmail ---------------------------------------------------------------------------------

describe('gmailImport (through the seam)', () => {
  const message = {
    messageId: 'msg-1',
    threadId: 'thread-9',
    preview: { body: 'Here is our price.' },
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
  let restore: () => void;
  beforeEach(() => { restore = serveBytes({ 'stage/att': Buffer.from('PK attachment bytes') }); });
  afterEach(() => restore());

  const gmail = (extra: (id: string, args: any) => any = () => undefined) => (id: string, args: any) => {
    const x = extra(id, args);
    if (x !== undefined) return x;
    if (id === 'svc:gmail.get_attachment') return { file: { name: args.file_name, mimetype: 'application/octet-stream', s3url: `https://x/stage/att/${args.attachment_id}` } };
    if (id === 'svc:gmail.fetch_message_by_thread_id') return { messages: [message] };
    if (id === 'svc:gmail.fetch_message_by_message_id') return message;
    return {};
  };

  it('saves the email and its real attachment, and skips the inline logo', async () => {
    const { svc, lib, provider } = build(gmail());
    const res = await svc.gmailImport('msg-1');
    expect(res.attachments).toBe(2);
    const names = lib.saved.map((s) => s.file.originalname);
    expect(names).toContain('quote.docx');
    expect(names).toContain('terms.pdf'); // a Content-ID does NOT mean inline
    expect(names).not.toContain('logo.png');
    // The attachment call carries the message, the attachment and the name the provider insists on.
    const att = calls(provider).find((c) => c.id === 'svc:gmail.get_attachment');
    expect(att.args).toEqual({ message_id: 'msg-1', attachment_id: 'att-1', file_name: 'quote.docx' });
    expect(lib.saved[1].file.buffer.toString('utf8')).toBe('PK attachment bytes');
  });

  it('keys each attachment on its own id, with a key short enough to store (BEA-1344)', async () => {
    const longId = 'A'.repeat(400); // real Gmail attachment ids run this long
    const twoFiles = { ...message, payload: { ...message.payload, parts: [
      { mimeType: DOCX, filename: 'invoice.pdf', body: { attachmentId: longId + '1' } },
      { mimeType: DOCX, filename: 'invoice.pdf', body: { attachmentId: longId + '2' } },
    ] } };
    const { svc, lib } = build(gmail((id) => (id === 'svc:gmail.fetch_message_by_thread_id' ? { messages: [twoFiles] } : undefined)));
    const res = await svc.gmailThreadImport('thread-9');
    expect(res.attachments).toBe(2); // two different files sharing a name are BOTH saved
    for (const call of (lib.findImported as jest.Mock).mock.calls) expect(String(call[0]).length).toBeLessThan(200);
  });

  it('puts everything from Gmail in the Email folder', async () => {
    const { svc, lib } = build(gmail());
    await svc.gmailImport('msg-1');
    expect(lib.ensureCollection).toHaveBeenCalledWith('Email', expect.anything());
    for (const s of lib.saved) expect(s.opts?.collectionId).toBe('col-email');
  });

  it('keeps who it is from, and the body, in the saved email', async () => {
    const { svc, lib } = build(gmail());
    await svc.gmailImport('msg-1');
    const md = lib.saved[0].file.buffer.toString('utf8');
    expect(md).toContain('# Quote for 25 boards');
    expect(md).toContain('vendor@example.com');
    expect(md).toContain('Here is our price.');
  });

  it('still saves the email when an attachment cannot be fetched', async () => {
    const { svc, lib } = build(gmail((id) => (id === 'svc:gmail.get_attachment' ? { __error: 'attachment gone' } : undefined)));
    const res = await svc.gmailImport('msg-1');
    expect(res.attachments).toBe(0);
    expect(lib.saved).toHaveLength(1); // the email itself survived
  });

  it('refreshes the same conversation instead of leaving a second copy', async () => {
    const { svc, lib } = build(gmail());
    lib.findImported = jest.fn(async (_url: string, filename: string) => (filename.endsWith('.md') ? { id: 'doc-existing', title: 'Quote for 25 boards' } : null)) as any;
    await svc.gmailThreadImport('thread-9');
    expect(lib.replaceContent).toHaveBeenCalledWith('doc-existing', expect.stringContaining('# Quote for 25 boards'));
    expect(lib.saved.map((s) => s.file.originalname)).not.toContain('Quote for 25 boards.md');
  });

  it('makes a safe filename from a subject with slashes', async () => {
    const odd = { ...message, payload: { ...message.payload, headers: [{ name: 'Subject', value: 'RFQ 12/08 <urgent>' }], parts: [] } };
    const { svc, lib } = build(gmail((id) => (id === 'svc:gmail.fetch_message_by_message_id' ? odd : undefined)));
    await svc.gmailImport('msg-1');
    expect(lib.saved[0].file.originalname).not.toMatch(/[\\/<>]/);
  });

  it('reads a thread as text with quoted history stripped, oldest first — the Requests input', async () => {
    const reply = { ...message, messageId: 'msg-2', payload: { ...message.payload, headers: [{ name: 'From', value: 'me@example.com' }, { name: 'Date', value: 'Sun, 17 Aug 2026 09:00:00 +0530' }, { name: 'Subject', value: 'Re: Quote for 25 boards' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Thanks, agreed — please go ahead and ship the twenty-five boards next week.\n\nOn Sat, vendor wrote:\n> Here is our price.').toString('base64url') } }] } };
    const { svc } = build(gmail((id) => (id === 'svc:gmail.fetch_message_by_thread_id' ? { messages: [message, reply] } : undefined)));
    const t = await svc.gmailThread('thread-9');
    expect(t.subject).toBe('Quote for 25 boards');
    expect(t.messages).toHaveLength(2);
    expect(t.copy).toContain('--- Message 1 of 2 ---');
    expect(t.copy).toContain('Here is our price.');
    expect(t.copy).toContain('Thanks, agreed');
    expect(t.copy).not.toContain('> Here is our price.'); // quoted history removed
  });

  it('gmailMessageFull is the de-quoted body — what email memory stores', async () => {
    const { svc } = build(gmail());
    expect(await svc.gmailMessageFull('msg-1')).toBe('Here is our price.');
  });
});
