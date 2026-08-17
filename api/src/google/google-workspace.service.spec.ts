import { build, calls } from './google-workspace.testing';

/**
 * Google through the ServiceProvider seam (BEA-1351).
 *
 * The Drive and Gmail IMPORT tests (BEA-1341/1343/1344) live in `drive-gmail-import.spec.ts`, as
 * they always did. These lock the rest: one call per Gmail list, re-sorted into Gmail's order; the
 * calendar's stale default `timeMax` always overridden; `not-connected` when nothing is connected
 * at /tools; a `ToolCall` row on every call; the download cap enforced while streaming.
 */

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
    await expect(svc.gmailImportantForDay('2026-08-13')).rejects.toThrow('not-connected:gmail');
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
