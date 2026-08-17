import { GoogleWorkspaceService, googleSource } from './google-workspace.service';

/**
 * Google through the ServiceProvider seam (BEA-1351).
 *
 * The parsing tests are the ones `drive-gmail-import.spec.ts` locked for the bridge (BEA-1341/1343/
 * 1344) — same intent, same fixtures, only the transport asserted differently: instead of a `run()`
 * argv we check the `svc:` action and its arguments, and binary content comes back as a short-lived
 * download link the service must fetch. The rest lock what is new: one call per list re-sorted into
 * Gmail's order, the calendar's stale default `timeMax` always overridden, `not-connected` when
 * nothing is connected at /tools, and a `ToolCall` row on every call.
 */

type Upload = { originalname: string; mimetype?: string; buffer: Buffer };
type Opts = { collectionId?: string | null; sourceUrl?: string | null };

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function fakeLibrary() {
  const saved: { file: Upload; opts?: Opts }[] = [];
  return {
    saved,
    findImported: jest.fn(async () => null),
    replaceContent: jest.fn(async (id: string) => ({ id, title: 'refreshed' })),
    refreshFromUpload: jest.fn(async (id: string) => ({ id, title: 'refreshed' })),
    ensureCollection: jest.fn(async (name: string) => `col-${name.toLowerCase().replace(/\s+/g, '-')}`),
    createFromUpload: jest.fn(async (file: Upload, opts?: Opts) => {
      saved.push({ file, opts });
      return { id: `doc-${saved.length}`, title: file.originalname.replace(/\.[^.]+$/, '') };
    }),
  };
}

/** A provider stub: one ACTIVE account per toolkit unless told otherwise, and a scripted execute. */
function fakeProvider(answer: (actionId: string, args: any) => any, opts: { connected?: string[] | 'none' } = {}) {
  const connected = opts.connected;
  return {
    getService: jest.fn(async (slug: string) => {
      const on = connected === 'none' ? false : !connected || connected.includes(slug);
      return { slug, name: slug, connected: on, accounts: on ? [{ id: `ca_${slug}`, label: 'sandy@kiot.io', status: 'ACTIVE' }] : [] };
    }),
    execute: jest.fn(async (actionId: string, args: any) => {
      const data = await answer(actionId, args);
      if (data && data.__error) return { ok: false, error: data.__error, ms: 1 };
      return { ok: true, data, ms: 1 };
    }),
    refresh: jest.fn(),
  };
}

/** Binary content arrives as a link; stub the world's fetch to serve it. */
function serveBytes(files: Record<string, Buffer>) {
  const orig = global.fetch;
  global.fetch = jest.fn(async (url: any) => {
    const u = String(url);
    const hit = Object.entries(files).find(([k]) => u.includes(k));
    if (!hit) return { ok: false, status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) } as any;
    const buf = hit[1];
    return { ok: true, status: 200, headers: new Headers({ 'content-length': String(buf.length) }), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) } as any;
  }) as any;
  return () => { global.fetch = orig; };
}

function build(answer: (actionId: string, args: any) => any, opts: { connected?: string[] | 'none' } = {}) {
  const lib = fakeLibrary();
  const provider = fakeProvider(answer, opts);
  const prisma = { toolCall: { create: jest.fn(async () => ({})) } };
  const svc = new GoogleWorkspaceService(provider as any, lib as any, prisma as any);
  return { svc, lib, provider, prisma };
}

const calls = (provider: any) => (provider.execute as jest.Mock).mock.calls.map((c: any[]) => ({ id: c[0], args: c[1], opts: c[2] }));

// ---- switch ---------------------------------------------------------------------------------

describe('googleSource — the road Google reads take', () => {
  const before = process.env.GOOGLE_SOURCE;
  afterEach(() => { if (before === undefined) delete process.env.GOOGLE_SOURCE; else process.env.GOOGLE_SOURCE = before; });

  it('defaults to the bridge until the seam is proven, and flips only on an explicit setting', () => {
    delete process.env.GOOGLE_SOURCE;
    expect(googleSource()).toBe('bridge');
    process.env.GOOGLE_SOURCE = 'seam';
    expect(googleSource()).toBe('seam');
    process.env.GOOGLE_SOURCE = 'nonsense';
    expect(googleSource()).toBe('bridge');
  });
});

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

describe('Gmail lists (through the seam)', () => {
  const row = (id: string, ts: string, from: string, subject: string) => ({
    messageId: id, threadId: `t-${id}`, messageTimestamp: ts, sender: from, subject, preview: { body: `snip ${id}` },
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: `Date ${id}` }] },
  });

  it('asks for the day\'s important mail in ONE call and re-sorts the answer newest first (Gmail\'s order)', async () => {
    // The provider fetches metadata concurrently and answers in ARRIVAL order — here deliberately scrambled.
    const rows = [row('b', '2026-08-13T10:00:00Z', 'B <b@x>', 'Second'), row('c', '2026-08-13T05:00:00Z', 'C <c@x>', 'Third'), row('a', '2026-08-13T12:00:00Z', 'A <a@x>', 'First')];
    const { svc, provider } = build((id) => (id === 'svc:gmail.fetch_emails' ? { messages: rows, resultSizeEstimate: 3 } : {}));
    const out = await svc.gmailImportantForDay('2026-08-13', 25);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toEqual({ id: 'a', threadId: 't-a', from: 'A <a@x>', subject: 'First', date: 'Date a', snippet: 'snip a' });
    const c = calls(provider);
    expect(c).toHaveLength(1);
    expect(c[0].args).toEqual({ query: 'after:2026/08/13 before:2026/08/14 -category:promotions -category:social -category:updates -in:chats', max_results: 25, verbose: false });
  });

  it('counts a day\'s unread by the real ids, never the estimate (BEA-615)', async () => {
    const { svc, provider } = build((id) => (id === 'svc:gmail.fetch_emails' ? { messages: [{ messageId: '1' }, { messageId: '2' }], resultSizeEstimate: 201 } : {}));
    expect(await svc.gmailDayUnread('2026-08-13')).toBe(2);
    expect(calls(provider)[0].args).toEqual({ query: 'is:unread after:2026/08/13 before:2026/08/14', max_results: 500, ids_only: true });
  });

  it('search returns distinct threads, newest message per thread', async () => {
    const rows = [row('x1', '2026-08-13T12:00:00Z', 'A', 'S1'), { ...row('x2', '2026-08-13T11:00:00Z', 'B', 'S2'), threadId: 't-x1' }, row('x3', '2026-08-13T10:00:00Z', 'C', 'S3')];
    const { svc } = build((id) => (id === 'svc:gmail.fetch_emails' ? { messages: rows } : {}));
    const out = await svc.gmailSearchThreads('invoice', 5);
    expect(out.map((t) => t.threadId)).toEqual(['t-x1', 't-x3']);
    expect(out[0].subject).toBe('S1');
  });
});

// ---- Calendar, status, the seam itself -----------------------------------------------------

describe('the seam itself', () => {
  it('always passes timeMax to the calendar — its own default is a fixed date in the past', async () => {
    const { svc, provider } = build((id) => (id === 'svc:googlecalendar.events_list' ? { items: [{ id: 'e', summary: 'Stand up', start: { dateTime: '2026-08-18T12:30:00+05:30' }, end: { dateTime: '2026-08-18T12:45:00+05:30' }, htmlLink: 'l' }] } : {}));
    const out = await svc.calendar();
    expect(out).toEqual([{ id: 'e', summary: 'Stand up', start: '2026-08-18T12:30:00+05:30', end: '2026-08-18T12:45:00+05:30', location: null, link: 'l' }]);
    const args = calls(provider)[0].args;
    expect(args.calendarId).toBe('primary');
    expect(args.singleEvents).toBe(true);
    expect(new Date(args.timeMax).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(args.timeMax).getTime()).toBeGreaterThan(new Date(args.timeMin).getTime());
  });

  it('says not-connected when the service has no working account at /tools — never a vendor error — and writes it down', async () => {
    const { svc, provider, prisma } = build(() => ({}), { connected: 'none' });
    await expect(svc.gmailImportantForDay('2026-08-13')).rejects.toThrow('not-connected');
    expect(provider.execute).not.toHaveBeenCalled();
    // The attempt that never left the building is still in the flight recorder.
    const row = (prisma.toolCall.create as jest.Mock).mock.calls[0][0].data;
    expect(row).toEqual(expect.objectContaining({ action: 'svc:gmail.fetch_emails', ok: false, error: 'not-connected' }));
  });

  it('hints never probe Google Tasks when no Tasks login exists — no failed row per page open', async () => {
    const { svc, provider } = build((id) => (id === 'svc:gmail.get_profile' ? { response_data: { emailAddress: 'x' } } : id === 'svc:gmail.fetch_emails' ? { resultSizeEstimate: 3, messages: [] } : { items: [] }), { connected: ['gmail', 'googlecalendar'] });
    const h = await svc.hints();
    expect(h).toEqual({ connected: true, gmailUnread: 3, calendarNext: null, tasksOpen: null });
    expect(calls(provider).some((c) => c.id.startsWith('svc:googletasks.'))).toBe(false);
  });

  it('stops a staged download at the 40 MB cap while streaming, whatever the header says', async () => {
    const orig = global.fetch;
    const chunk = new Uint8Array(9 * 1024 * 1024);
    let handed = 0;
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200, headers: new Headers(), // no content-length at all
      body: { getReader: () => ({ read: async () => (handed++ < 6 ? { done: false, value: chunk } : { done: true }), cancel: async () => undefined }) },
      arrayBuffer: async () => { throw new Error('must stream, not buffer'); },
    })) as any;
    try {
      const { svc } = build((id) => (id === 'svc:googledrive.get_file_metadata' ? { name: 'big.bin', mimeType: 'application/octet-stream' } : id === 'svc:googledrive.find_file' ? { files: [] } : { downloaded_file_content: { s3url: 'https://x/big' } }));
      await expect(svc.driveImport('file-big')).rejects.toThrow(/too big/i);
      expect(handed).toBeLessThan(6); // it gave up before reading everything
    } finally {
      global.fetch = orig;
    }
  });

  it('status is offline-safe and reflects which of Gmail / Drive / Calendar are connected', async () => {
    const { svc } = build((id) => (id === 'svc:gmail.get_profile' ? { response_data: { emailAddress: 'sandy@kiot.io' } } : {}), { connected: ['gmail', 'googledrive'] });
    expect(await svc.status()).toEqual({ connected: true, email: 'sandy@kiot.io', gmail: true, drive: true, calendar: false });
    const { svc: off } = build(() => ({}), { connected: 'none' });
    expect(await off.status()).toEqual({ connected: false, email: null, gmail: false, drive: false, calendar: false });
  });

  it('writes a ToolCall row for every real read, on the account it ran on, and none for a status probe', async () => {
    const { svc, prisma } = build((id) => (id === 'svc:gmail.get_profile' ? { response_data: { emailAddress: 'sandy@kiot.io' } } : { messages: [] }));
    await svc.status();
    expect(prisma.toolCall.create).not.toHaveBeenCalled();
    await svc.gmailImportantForDay('2026-08-13');
    expect(prisma.toolCall.create).toHaveBeenCalledTimes(1);
    const row = (prisma.toolCall.create as jest.Mock).mock.calls[0][0].data;
    expect(row).toEqual(expect.objectContaining({ service: 'gmail', action: 'svc:gmail.fetch_emails', accountId: 'ca_gmail', ok: true, runKind: 'google', gated: false }));
    expect(row.arguments).toContain('-category:promotions');
  });

  it('a failed action surfaces the service\'s own reason and is recorded as failed', async () => {
    const { svc, prisma } = build(() => ({ __error: '{"message":"Requested entity was not found.","status":404}' }));
    await expect(svc.gmailMessageFull('nope')).rejects.toThrow('Requested entity was not found.');
    const row = (prisma.toolCall.create as jest.Mock).mock.calls[0][0].data;
    expect(row.ok).toBe(false);
    expect(row.error).toContain('not found');
  });

  it('never lets a vendor name into an action id — every id is svc:<service>.<action>', async () => {
    const { svc, provider } = build(() => ({ messages: [], files: [], items: [] }));
    await svc.gmailUnreadCount();
    await svc.driveList();
    await svc.calendar();
    for (const c of calls(provider)) expect(c.id).toMatch(/^svc:[a-z0-9_]+\.[a-z0-9_]+$/);
    expect(calls(provider).map((c) => c.id)).toEqual(['svc:gmail.fetch_emails', 'svc:googledrive.find_file', 'svc:googlecalendar.events_list']);
  });
});
