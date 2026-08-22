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
    const { svc, provider } = build((id) => (id === 'svc:gmail.get_profile' ? { response_data: { emailAddress: 'x' } } : { items: [] }), { connected: ['gmail', 'googlecalendar'], briefs: [{ day: '2026-08-22', unread: 3 }] });
    const h = await svc.hints();
    expect(h).toEqual({ connected: true, gmailUnread: 3, gmailUnreadDay: '2026-08-22', calendarNext: null, tasksOpen: null });
    expect(calls(provider).some((c) => c.id.startsWith('svc:googletasks.'))).toBe(false);
  });

  it('hints read the unread count from the STORED brief — opening the Google page never calls Gmail (BEA-1399)', async () => {
    const { svc, provider } = build((id) => (id === 'svc:gmail.get_profile' ? { response_data: { emailAddress: 'x' } } : { items: [] }), { connected: ['gmail'], settings: { 'google.email': 'o@x.io' }, briefs: [{ day: '2026-08-21', unread: 7 }, { day: '2026-08-22', unread: 2 }] });
    const h = await svc.hints();
    expect(h.gmailUnread).toBe(2);
    expect(h.gmailUnreadDay).toBe('2026-08-22');
    expect(calls(provider).some((c) => c.id.startsWith('svc:gmail.'))).toBe(false);
    const { svc: none } = build(() => ({}), { connected: ['gmail'], settings: { 'google.email': 'o@x.io' } });
    expect((await none.hints()).gmailUnread).toBeNull();
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

  it('remembers the connected address after ONE counted probe — status() never asks Gmail again (BEA-1399)', async () => {
    const { svc, provider, toolCalls, settings } = build((id) => (id === 'svc:gmail.get_profile' ? { response_data: { emailAddress: 'sandy@kiot.io' } } : { messages: [] }));
    expect((await svc.status()).email).toBe('sandy@kiot.io');
    expect(settings['google.email']).toBe('sandy@kiot.io');
    expect(toolCalls.filter((r) => r.action === 'svc:gmail.get_profile')).toHaveLength(1); // counted, like every call
    await svc.status();
    await svc.status();
    expect(calls(provider).filter((c) => c.id === 'svc:gmail.get_profile')).toHaveLength(1);
    // A fresh instance (a restart) reads the remembered address and asks nothing.
    const again = build(() => ({}), { settings: { 'google.email': 'sandy@kiot.io' } });
    expect((await again.svc.status()).email).toBe('sandy@kiot.io');
    expect(again.provider.execute).not.toHaveBeenCalled();
  });

  it('a failing address probe is not retried on every page open — once, then it backs off (review HIGH)', async () => {
    const { svc, provider } = build((id) => (id === 'svc:gmail.get_profile' ? { __error: 'boom' } : { messages: [] }));
    expect((await svc.status()).email).toBeNull();
    await svc.status();
    await svc.status();
    expect(calls(provider).filter((c) => c.id === 'svc:gmail.get_profile')).toHaveLength(1);
  });

  it('a reconnected Gmail (different account id) learns the new address once — never shows the old one (review MEDIUM)', async () => {
    const { svc, provider, settings } = build((id) => (id === 'svc:gmail.get_profile' ? { response_data: { emailAddress: 'new@x.io' } } : {}), {
      settings: { 'google.email': 'old@x.io', 'google.emailAccount': 'ca_previous' },
    });
    expect((await svc.status()).email).toBe('new@x.io');
    expect(settings['google.email']).toBe('new@x.io');
    expect(settings['google.emailAccount']).toBe('ca_gmail');
    await svc.status();
    expect(calls(provider).filter((c) => c.id === 'svc:gmail.get_profile')).toHaveLength(1);
  });

  it('writes a ToolCall row for every real read, on the account it ran on', async () => {
    const { svc, prisma } = build(() => ({ messages: [] }), { settings: { 'google.email': 'sandy@kiot.io' } });
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

describe('the Gmail daily cap and counter (BEA-1399)', () => {
  const today = () => new Date();

  it('refuses the call past the cap with a plain sentence, writes it down, and never reaches the vendor', async () => {
    const { svc, provider, toolCalls } = build(() => ({ messages: [] }), {
      settings: { 'gmail.dailyCap': '2', 'google.email': 'o@x.io' },
      toolCalls: [
        { service: 'gmail', action: 'svc:gmail.fetch_emails', ok: true, createdAt: today() },
        { service: 'gmail', action: 'svc:gmail.fetch_emails', ok: true, createdAt: today() },
      ],
    });
    await expect(svc.gmailImportantForDay('2026-08-22')).rejects.toThrow('gmail-cap:2:2');
    expect(provider.execute).not.toHaveBeenCalled();
    const last = toolCalls[toolCalls.length - 1];
    expect(last).toEqual(expect.objectContaining({ service: 'gmail', ok: false, error: 'gmail-cap' }));
  });

  it('rows that never reached the vendor (cap, not-connected) and yesterday\'s rows do not count', async () => {
    const yesterday = new Date(Date.now() - 36 * 3600_000);
    const { svc, provider } = build(() => ({ messages: [] }), {
      settings: { 'gmail.dailyCap': '2', 'google.email': 'o@x.io' },
      toolCalls: [
        { service: 'gmail', action: 'svc:gmail.fetch_emails', ok: false, error: 'gmail-cap', createdAt: today() },
        { service: 'gmail', action: 'svc:gmail.fetch_emails', ok: false, error: 'not-connected', createdAt: today() },
        { service: 'gmail', action: 'svc:gmail.fetch_emails', ok: true, createdAt: yesterday },
        { service: 'googledrive', action: 'svc:googledrive.find_file', ok: true, createdAt: today() },
        { service: 'gmail', action: 'svc:gmail.fetch_emails', ok: true, createdAt: today() },
      ],
    });
    await svc.gmailImportantForDay('2026-08-22'); // 1 real call today + this one = 2 = the cap, allowed
    expect(provider.execute).toHaveBeenCalledTimes(1);
    await expect(svc.gmailImportantForDay('2026-08-22')).rejects.toThrow('gmail-cap:2:2');
  });

  it('cap 0 means no cap; the default is 60', async () => {
    const { svc, provider } = build(() => ({ messages: [] }), { settings: { 'gmail.dailyCap': '0', 'google.email': 'o@x.io' }, toolCalls: Array.from({ length: 500 }, () => ({ service: 'gmail', action: 'svc:gmail.fetch_emails', ok: true, createdAt: today() })) });
    await svc.gmailImportantForDay('2026-08-22');
    expect(provider.execute).toHaveBeenCalledTimes(1);
    const { svc: dflt } = build(() => ({ messages: [] }), { settings: { 'google.email': 'o@x.io' } });
    expect((await dflt.gmailUsage()).cap).toBe(60);
  });

  it('the cap is a Setting the owner can change; nonsense is refused', async () => {
    const { svc, settings } = build(() => ({}), {});
    expect(await svc.setGmailCap(120)).toBe(120);
    expect(settings['gmail.dailyCap']).toBe('120');
    await expect(svc.setGmailCap(-1)).rejects.toThrow();
    await expect(svc.setGmailCap(Number.NaN)).rejects.toThrow();
  });

  it('usage counts today\'s real Gmail calls by action and names the next scheduled read', async () => {
    const { svc } = build(() => ({ messages: [] }), {
      settings: { 'gmail.dailyCap': '60', 'google.email': 'o@x.io' },
      toolCalls: [
        { service: 'gmail', action: 'svc:gmail.fetch_emails', ok: true, createdAt: today() },
        { service: 'gmail', action: 'svc:gmail.fetch_message_by_message_id', ok: true, createdAt: today() },
        { service: 'gmail', action: 'svc:gmail.fetch_message_by_message_id', ok: true, createdAt: today() },
        { service: 'gmail', action: 'svc:gmail.fetch_emails', ok: false, error: 'gmail-cap', createdAt: today() },
      ],
    });
    const u = await svc.gmailUsage();
    expect(u.calls).toBe(3);
    expect(u.cap).toBe(60);
    expect(u.tz).toBe('Asia/Kolkata');
    expect(u.byAction).toEqual([{ action: 'fetch_message_by_message_id', n: 2 }, { action: 'fetch_emails', n: 1 }]);
    expect(u.schedule).toEqual({ early: '21:00', final: '23:30' });
    expect(['today', 'tomorrow']).toContain(u.next.day);
    expect(['21:00', '23:30']).toContain(u.next.time);
    expect(u.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
