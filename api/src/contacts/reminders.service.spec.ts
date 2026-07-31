import { spreadTimes, localTimesToUtc, scheduleNudges, scheduleOnDay, RemindersService, looksCommandLike, stripCommandLead, sanitizeTimes, topicFromMessage, chatWindowOpen, CHAT_WINDOW_MS, dailySubject } from './reminders.service';

describe('update() reschedule (BEA-883)', () => {
  const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const futureIST = (d: number) => new Date(Date.now() + 330 * 60000 + d * 86400000).toISOString().slice(0, 10);

  function makeSvc(cur: any) {
    let created: Date[] = [];
    let row = { ...cur };
    const prisma: any = {
      setting: { findUnique: async () => null },
      reminder: {
        findUnique: async ({ include }: any) => ({ ...row, contact: { name: 'A' }, ...(include?.sends ? { sends: created.map((at, i) => ({ id: 's' + i, at, status: 'queued' })) } : {}) }),
        update: async ({ data }: any) => { row = { ...row, ...data }; return {}; },
      },
      reminderSend: { deleteMany: async () => ({}), createMany: async ({ data }: any) => { created = data.map((d: any) => d.at); } },
      task: { findUnique: async () => null },
    };
    return { svc: new RemindersService(prisma, {} as any, {} as any, {} as any), sends: () => created, row: () => row };
  }

  it('moves an active reminder to a future day when edited', async () => {
    const future = futureIST(6);
    const h = makeSvc({ id: 'r1', taskId: null, status: 'active', armedDay: todayIST(), times: JSON.stringify(['09:00']), pausedAuto: false });
    await h.svc.update('r1', { message: 'updated', startDay: future });
    expect(h.sends()).toHaveLength(1);
    const dayIST = new Date(h.sends()[0].getTime() + 330 * 60000).toISOString().slice(0, 10);
    expect(dayIST).toBe(future); // rescheduled onto the chosen day
    expect(h.row().armedDay).toBe(future);
  });

  it('preserves a future reminder when an unrelated edit omits the date', async () => {
    const future = futureIST(5);
    const h = makeSvc({ id: 'r1', taskId: null, status: 'active', armedDay: future, times: JSON.stringify(['09:00']), pausedAuto: false });
    await h.svc.update('r1', { message: 'just fixing the wording' }); // no startDay
    const dayIST = new Date(h.sends()[0].getTime() + 330 * 60000).toISOString().slice(0, 10);
    expect(dayIST).toBe(future); // NOT dragged to today
  });

  it('moves a future reminder back to today when the date is set to today', async () => {
    const future = futureIST(4);
    const h = makeSvc({ id: 'r1', taskId: null, status: 'active', armedDay: future, times: JSON.stringify(['09:00']), pausedAuto: false });
    await h.svc.update('r1', { startDay: todayIST() }); // explicit today
    // today 09:00 may already be past → 0 or a today/tomorrow spill, but NOT the original future day
    const days = h.sends().map((at) => new Date(at.getTime() + 330 * 60000).toISOString().slice(0, 10));
    expect(days).not.toContain(future);
  });
});

describe('suggestion dismiss (BEA-882)', () => {
  it('dismissSuggestion flags the task so it stops showing', async () => {
    const updated: any[] = [];
    const prisma: any = { task: { update: async ({ where, data }: any) => { updated.push({ id: where.id, ...data }); return {}; } } };
    const svc = new RemindersService(prisma, {} as any, {} as any, {} as any);
    await svc.dismissSuggestion('t1');
    expect(updated[0]).toEqual({ id: 't1', reminderSuggestDismissed: true });
  });

  it('dismissSuggestion rejects a missing taskId', async () => {
    const svc = new RemindersService({} as any, {} as any, {} as any, {} as any);
    await expect(svc.dismissSuggestion('')).rejects.toThrow();
  });

  it('dismissAllSuggestions clears every current suggestion', async () => {
    const updatedMany: any[] = [];
    const prisma: any = {
      task: { findMany: async () => [{ id: 't1', title: 'x', party: 'A', dueDate: null, pinned: false }], updateMany: async ({ where, data }: any) => { updatedMany.push({ ids: where.id.in, data }); return { count: where.id.in.length }; } },
      reminder: { findMany: async () => [] },
    };
    const contacts: any = { findByName: async () => ({ id: 'k1', name: 'A', whatsappNumber: '9' }) };
    const svc = new RemindersService(prisma, {} as any, contacts, {} as any);
    const r = await svc.dismissAllSuggestions();
    expect(r.dismissed).toBe(1);
    expect(updatedMany[0]).toEqual({ ids: ['t1'], data: { reminderSuggestDismissed: true } });
  });
});

describe('scheduleOnDay — future-dated reminders (BEA-876)', () => {
  const IST = 330; // minutes
  it('schedules the slot on the given future day, in the future, and never earlier', () => {
    const now = new Date('2026-07-05T03:00:00Z'); // 08:30 IST, 5 Jul
    const sends = scheduleOnDay(['09:00'], '2026-07-10', now); // Fri 10 Jul, 09:00 IST
    expect(sends).toHaveLength(1);
    // 09:00 IST on 10 Jul == 03:30 UTC on 10 Jul
    expect(sends[0].toISOString()).toBe('2026-07-10T03:30:00.000Z');
    expect(sends[0].getTime()).toBeGreaterThan(now.getTime()); // strictly future → tick won't fire it now
  });

  it('drops slots that are already in the past (same-day, time gone)', () => {
    const now = new Date('2026-07-05T10:00:00Z'); // 15:30 IST
    expect(scheduleOnDay(['09:00'], '2026-07-05', now)).toHaveLength(0); // 09:00 IST already passed
  });

  it('returns nothing for a malformed day', () => {
    expect(scheduleOnDay(['09:00'], 'not-a-date', new Date())).toEqual([]);
  });

  it('keeps multiple slots sorted', () => {
    const now = new Date('2026-07-05T03:00:00Z');
    const sends = scheduleOnDay(['18:00', '09:00'], '2026-07-10', now);
    expect(sends.map((d) => d.getTime())).toEqual([...sends.map((d) => d.getTime())].sort((a, b) => a - b));
    void IST;
  });
});

describe('sanitizeTimes — user-chosen send slots (BEA-755)', () => {
  it('keeps valid times, zero-pads, dedupes, sorts, caps at 5', () => {
    expect(sanitizeTimes(['9:00', '17:00', '13:00'])).toEqual(['09:00', '13:00', '17:00']); // padded + sorted
    expect(sanitizeTimes(['09:00', '09:00'])).toEqual(['09:00']); // deduped
    expect(sanitizeTimes(['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00'])).toHaveLength(8); // capped at 8 (BEA-920)
  });
  it('drops invalid entries and non-arrays → [] (caller then rejects/falls back)', () => {
    expect(sanitizeTimes(['25:00', '09:61', 'lunch', ''])).toEqual([]);
    expect(sanitizeTimes(undefined)).toEqual([]);
    expect(sanitizeTimes('09:00' as any)).toEqual([]);
  });
});

describe('looksCommandLike / stripCommandLead (BEA-754)', () => {
  it('flags command-style subjects, passes clean topics through', () => {
    expect(looksCommandLike('Ask Srikar to report on socket pins work')).toBe(true);
    expect(looksCommandLike('Follow up with Srikar on Zigbee dongle testing')).toBe(true);
    expect(looksCommandLike('Tell Dharmendra to label Beakn in videos')).toBe(true);
    expect(looksCommandLike('the socket pins work')).toBe(false); // already a topic
    expect(looksCommandLike('the status report')).toBe(false);
    expect(looksCommandLike('')).toBe(false);
  });
  it('deterministic fallback strips the leading command clause', () => {
    expect(stripCommandLead('Ask Srikar to report on socket pins work')).toBe('report on socket pins work');
    expect(stripCommandLead('Follow up with Srikar on Zigbee dongle testing')).toBe('Zigbee dongle testing');
    expect(stripCommandLead('the status report')).toBe('the status report'); // nothing to strip → unchanged
  });
});

describe('RemindersService.cleanSubject (BEA-754)', () => {
  const prisma: any = { setting: { findUnique: async () => null } };

  it('leaves an already-clean subject untouched (no AI call)', async () => {
    let called = 0;
    const llm: any = { completeWith: async () => { called++; return 'x'; } };
    const svc = new RemindersService(prisma, llm, {} as any, {} as any);
    expect(await svc.cleanSubject('the socket pins work', 'Srikar')).toBe('the socket pins work');
    expect(called).toBe(0); // clean subjects skip the model entirely
  });

  it('rewrites a command-like subject into the AI noun phrase', async () => {
    const llm: any = { completeWith: async () => '"the socket pins work."' };
    const svc = new RemindersService(prisma, llm, {} as any, {} as any);
    expect(await svc.cleanSubject('Ask Srikar to report on socket pins work', 'Srikar')).toBe('the socket pins work'); // quotes + trailing dot stripped
  });

  it('falls back to the deterministic strip when the model returns nothing', async () => {
    const llm: any = { completeWith: async () => '' };
    const svc = new RemindersService(prisma, llm, {} as any, {} as any);
    expect(await svc.cleanSubject('Follow up with Srikar on Zigbee dongle testing', 'Srikar')).toBe('Zigbee dongle testing');
  });

  it('returns empty for an empty subject', async () => {
    const svc = new RemindersService(prisma, { completeWith: async () => '' } as any, {} as any, {} as any);
    expect(await svc.cleanSubject('', 'Srikar')).toBe('');
    expect(await svc.cleanSubject(null, 'Srikar')).toBe('');
  });
});

describe('scheduleNudges — fixed total, spill over days (BEA-740)', () => {
  const times = ['09:00', '12:45', '16:30']; // spreadTimes(3)
  it('made in the morning → all nudges go today', () => {
    const now = new Date('2026-07-01T02:00:00Z'); // 07:30 IST
    const out = scheduleNudges(times, now, 330);
    expect(out).toHaveLength(3);
    expect(out.every((d) => d.toISOString().slice(0, 10) === '2026-07-01')).toBe(true);
  });
  it('made at 4 PM → 1 today, the remaining 2 roll to tomorrow', () => {
    const now = new Date('2026-07-01T10:30:00Z'); // 16:00 IST
    const out = scheduleNudges(times, now, 330);
    expect(out).toHaveLength(3);
    expect(out[0].toISOString()).toBe('2026-07-01T11:00:00.000Z'); // today 16:30 IST
    expect(out[1].toISOString()).toBe('2026-07-02T03:30:00.000Z'); // tomorrow 09:00 IST
    expect(out[2].toISOString()).toBe('2026-07-02T07:15:00.000Z'); // tomorrow 12:45 IST
  });
  it('made late evening → all nudges roll to tomorrow', () => {
    const now = new Date('2026-07-01T18:00:00Z'); // 23:30 IST
    const out = scheduleNudges(times, now, 330);
    expect(out).toHaveLength(3);
    expect(out.every((d) => d.toISOString().slice(0, 10) === '2026-07-02')).toBe(true);
  });
});

describe('RemindersService.thread — whole contact conversation (BEA-789)', () => {
  it('shows all of the contact\'s messages, even a combined nudge tagged to another reminder', async () => {
    const prisma: any = {
      reminder: { findUnique: async () => ({ id: 'r2', status: 'active', feedback: null, contactId: 'c1', contact: { name: 'Srikar' } }) },
      reminderMessage: {
        findMany: async ({ where }: any) => (where.contactId === 'c1'
          ? [{ id: 'm1', direction: 'out', body: 'combined nudge (tagged to r1)', createdAt: new Date() }, { id: 'm2', direction: 'in', body: 'done', createdAt: new Date() }]
          : []),
      },
    };
    const svc = new RemindersService(prisma, {} as any, {} as any, {} as any);
    const t = await svc.thread('r2');
    expect(t.contactName).toBe('Srikar');
    expect(t.messages).toHaveLength(2); // the nudge shows here too, not an empty chat
  });
});

describe('RemindersService.reseed — arm for the first send day (BEA-785)', () => {
  it('arms a reminder for the IST day of its first scheduled send, not always today', async () => {
    const captured: any = {};
    const prisma: any = {
      reminderSend: { deleteMany: async () => ({}), createMany: async ({ data }: any) => { captured.sends = data; return { count: data.length }; } },
      reminder: { update: async ({ data }: any) => { captured.armedDay = data.armedDay; return {}; } },
    };
    const svc = new RemindersService(prisma, {} as any, {} as any, {} as any);
    await (svc as any).reseed('r1', ['09:00', '13:00', '16:30']);
    // whatever "now" is, armedDay must equal the IST day of the first send — so a late-evening
    // reminder (all sends tomorrow) is armed for tomorrow and survives tonight's rollDay.
    const firstSendIstDay = new Date(new Date(captured.sends[0].at).getTime() + 330 * 60000).toISOString().slice(0, 10);
    expect(captured.armedDay).toBe(firstSendIstDay);
  });
});

describe('localTimesToUtc — reminder times are in the user tz (BEA-734)', () => {
  it('interprets HH:MM as IST and converts to the right UTC instant', () => {
    const now = new Date('2026-07-01T00:00:00Z'); // 05:30 IST, same local day
    const [d] = localTimesToUtc(['09:00'], now, 330);
    expect(d.toISOString()).toBe('2026-07-01T03:30:00.000Z'); // 9 AM IST = 03:30 UTC
  });
  it('skips slots already >2 min in the past, keeps future ones', () => {
    const now = new Date('2026-07-01T12:00:00Z'); // 17:30 IST
    const out = localTimesToUtc(['09:00', '20:00'], now, 330);
    expect(out).toHaveLength(1); // 9 AM IST already passed → skipped
    expect(out[0].toISOString()).toBe('2026-07-01T14:30:00.000Z'); // 8 PM IST = 14:30 UTC
  });
});

describe('RemindersService.suggestions (BEA-721)', () => {
  it('lists open tasks with a party, resolves contacts, flags no-number + active reminder', async () => {
    const prisma: any = {
      task: { findMany: async () => [
        { id: 't1', title: 'Get PCB samples', party: 'Ravi', dueDate: null, pinned: false },
        { id: 't2', title: 'Call back', party: 'Sunil', dueDate: null, pinned: false },
        { id: 't3', title: 'No party', party: '  ', dueDate: null, pinned: false },
      ] },
      reminder: { findMany: async () => [{ taskId: 't2' }] },
    };
    const contacts: any = { findByName: async (n: string) => (n.toLowerCase() === 'ravi' ? { id: 'c1', name: 'Ravi', whatsappNumber: '91999' } : null) };
    const svc = new RemindersService(prisma, {} as any, contacts, {} as any);
    const { suggestions } = await svc.suggestions();
    expect(suggestions).toHaveLength(2); // blank-party task excluded
    const ravi = suggestions.find((s) => s.task.id === 't1')!;
    expect(ravi.noNumber).toBe(false);
    const sunil = suggestions.find((s) => s.task.id === 't2')!;
    expect(sunil.noNumber).toBe(true); // no matching contact
    expect(sunil.hasActiveReminder).toBe(true);
  });
});


describe('RemindersService.scanTasksForPeople (BEA-738)', () => {
  it('backfills party on open tasks that name a person, skips the rest', async () => {
    const updates: any[] = [];
    const prisma: any = {
      task: {
        findMany: async () => [{ id: 't1', title: 'Follow up with Srikar on the dongle' }, { id: 't2', title: 'Work on the portal' }],
        update: async ({ where, data }: any) => updates.push({ id: where.id, party: data.party }),
      },
      setting: { findUnique: async () => null }, // voiceComplete → default engine
    };
    const llm: any = { completeWith: async () => '[{"id":"t1","person":"Srikar"},{"id":"t2","person":null}]' };
    const svc = new RemindersService(prisma, llm, {} as any, {} as any);
    const res = await svc.scanTasksForPeople();
    expect(res).toEqual({ scanned: 2, updated: 1 });
    expect(updates).toEqual([{ id: 't1', party: 'Srikar' }]);
  });

  it('does nothing when no open task has a blank party', async () => {
    const prisma: any = { task: { findMany: async () => [] } };
    const svc = new RemindersService(prisma, {} as any, {} as any, {} as any);
    expect(await svc.scanTasksForPeople()).toEqual({ scanned: 0, updated: 0 });
  });

  it('ignores AI ids that are not in the scanned set', async () => {
    const updates: any[] = [];
    const prisma: any = {
      task: { findMany: async () => [{ id: 't1', title: 'Ask Ravi for the file' }], update: async ({ where, data }: any) => updates.push({ id: where.id, party: data.party }) },
      setting: { findUnique: async () => null },
    };
    const llm: any = { completeWith: async () => '[{"id":"HALLUCINATED","person":"Ghost"},{"id":"t1","person":"Ravi"}]' };
    const svc = new RemindersService(prisma, llm, {} as any, {} as any);
    const res = await svc.scanTasksForPeople();
    expect(res.updated).toBe(1);
    expect(updates).toEqual([{ id: 't1', party: 'Ravi' }]);
  });
});

describe('RemindersService pause/resume (BEA-720)', () => {
  function makeSvc(cur: any) {
    const calls = { deleteMany: 0, createMany: 0, updateData: null as any };
    const prisma: any = {
      reminder: {
        findUnique: async () => cur,
        update: async ({ data }: any) => { calls.updateData = { ...calls.updateData, ...data }; cur = { ...cur, ...data }; return cur; }, // merge across the status + reseed(armedDay) updates
      },
      reminderSend: {
        deleteMany: async () => { calls.deleteMany++; return {}; },
        createMany: async () => { calls.createMany++; return {}; },
      },
    };
    const svc = new RemindersService(prisma, {} as any, {} as any, {} as any);
    return { svc, calls };
  }

  it('pause → status paused, clears queued sends, queues nothing new', async () => {
    const { svc, calls } = makeSvc({ id: 'r1', status: 'active', times: JSON.stringify(['09:00', '16:30']), taskId: null, contact: {}, sends: [] });
    await svc.pause('r1');
    expect(calls.updateData.status).toBe('paused');
    expect(calls.deleteMany).toBe(1);
    expect(calls.createMany).toBe(0);
  });

  it('resume → status active, reseeds today’s remaining sends', async () => {
    const { svc, calls } = makeSvc({ id: 'r1', status: 'paused', times: JSON.stringify(['09:00', '16:30']), taskId: null, contact: {}, sends: [] });
    await svc.resume('r1');
    expect(calls.updateData.status).toBe('active');
    expect(calls.deleteMany).toBe(1); // reseed ran (createMany count is time-of-day dependent after the IST/skip-past fix, so we don't assert it)
  });
});

describe('RemindersService.draftMessage clean up (BEA-720/731)', () => {
  // No picker set → the default (reliable) engine; formatComplete calls llm.completeWith.
  const prisma: any = { setting: { findUnique: async () => null } };

  it('reformats the user’s own rough words via the chosen engine', async () => {
    const llm: any = { completeWith: async () => '  "Hi Ravi, any update on the samples?"  ' };
    const svc = new RemindersService(prisma, llm, {} as any, {} as any);
    const { message } = await svc.draftMessage({ userInput: 'chase ravi re samples', contactName: 'Ravi' });
    expect(message).toBe('Hi Ravi, any update on the samples?'); // quotes + whitespace stripped
  });

  it('retries once, then falls back to the raw words if the engine keeps failing (BEA-731)', async () => {
    let calls = 0;
    const llm: any = { completeWith: async () => { calls++; return ''; } };
    const svc = new RemindersService(prisma, llm, {} as any, {} as any);
    const { message } = await svc.draftMessage({ userInput: 'call sunil tomorrow', contactName: 'Sunil' });
    expect(message).toBe('call sunil tomorrow'); // raw preserved, never lost
    expect(calls).toBe(2); // tried, then retried once
  });

  it('task draft returns a clean short subject + message (BEA-739)', async () => {
    const llm: any = { completeWith: async () => '{"message":"Hi Raja, any update on those videos?","subject":"the panel videos"}' };
    const svc = new RemindersService(prisma, llm, {} as any, {} as any);
    const r = await svc.draftMessage({ taskTitle: 'Instruct Raja to create panel videos', contactName: 'Raja' });
    expect(r.message).toContain('any update');
    expect(r.subject).toBe('the panel videos'); // clean noun phrase, not the raw title
  });

  it('task draft falls back to the title as subject if AI output is unparseable (BEA-739)', async () => {
    const llm: any = { completeWith: async () => 'not json at all' };
    const svc = new RemindersService(prisma, llm, {} as any, {} as any);
    const r = await svc.draftMessage({ taskTitle: 'Chase Ravi for the file', contactName: 'Ravi' });
    expect(r.subject).toBe('Chase Ravi for the file'); // graceful fallback
  });
});

describe('spreadTimes (BEA-720)', () => {
  it('1 reminder → just the morning', () => {
    expect(spreadTimes(1)).toEqual(['09:00']);
  });
  it('3 reminders → spread across the day (first 9, last 16:30)', () => {
    const t = spreadTimes(3);
    expect(t[0]).toBe('09:00');
    expect(t[2]).toBe('16:30');
    expect(t).toHaveLength(3);
  });
  it('caps at 5 and is sorted ascending', () => {
    const t = spreadTimes(9);
    expect(t).toHaveLength(5);
    const mins = t.map((x) => Number(x.split(':')[0]) * 60 + Number(x.split(':')[1]));
    expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  });
  it('clamps below 1 to 1', () => {
    expect(spreadTimes(0)).toEqual(['09:00']);
  });
});

describe('resendTemplate (BEA-917 / BEA-1042)', () => {
  function harness(openReminders: any[], tasks: Record<string, string> = {}) {
    const created: any[] = [];
    const calls: any = { single: null, list: null };
    const prisma: any = {
      reminder: {
        findUnique: async () => ({ id: 'r1', contactId: 'k1', taskId: null, subject: 'the update', message: 'm', contact: { name: 'Rakesh', whatsappNumber: '919999999999' } }),
        findMany: async () => openReminders,
      },
      task: { findUnique: async ({ where }: any) => (tasks[where.id] ? { title: tasks[where.id] } : null) },
      reminderMessage: { create: async ({ data }: any) => { created.push(data); return { id: 'm1', ...data, createdAt: new Date() }; } },
    };
    const postbox: any = {
      isConfigured: () => true,
      sendReminderTemplate: async (to: string, first: string, subject: string) => { calls.single = { to, first, subject }; return { wamid: 'w9', status: 'sent', error: null }; },
      renderReminderTemplate: (f: string, s2: string) => `Hi ${f}, I'm following up on behalf of Sandeep about ${s2}. Could you let him know where it stands? A quick tap below is enough.`,
      sendTaskListTemplate: async (to: string, first: string, n: number, list: string, slug: string) => { calls.list = { to, first, n, list, slug }; return { wamid: 'w9', status: 'sent', error: null }; },
      renderTaskListTemplate: (f: string, n: number, list: string) => `Hi ${f}, following up on behalf of Sandeep — ${n} things are pending with him: ${list}. Just reply here with where things stand.`,
    };
    const contacts: any = { share: async () => ({ slug: 'rakesh-9x2k' }) };
    const svc = new RemindersService(prisma, {} as any, contacts, postbox);
    return { svc, created, calls };
  }

  it('one open item: the single-task template, with the task\'s CURRENT title, not the stored snapshot', async () => {
    const { svc, created, calls } = harness([{ id: 'r1', taskId: 't1', subject: 'the OLD wording', message: 'm', createdAt: new Date(1) }], { t1: 'Send the signed agreement' });
    const res: any = await svc.resendTemplate('r1');
    expect(calls.single).toEqual({ to: '919999999999', first: 'Rakesh', subject: 'Send the signed agreement' });
    expect(calls.list).toBeNull();
    expect(res.status).toBe('sent');
    expect(created[0].body).toContain('Send the signed agreement');
  });

  it('two or more open items: the numbered list template with their page button — same as the scheduler (BEA-1042)', async () => {
    const { svc, calls } = harness(
      [
        { id: 'r1', taskId: 't1', subject: '', message: 'm', createdAt: new Date(1) },
        { id: 'r2', taskId: 't2', subject: '', message: 'm', createdAt: new Date(2) },
      ],
      { t1: 'Upload the BOM', t2: 'Send the status report' },
    );
    await svc.resendTemplate('r1');
    expect(calls.list).toEqual({ to: '919999999999', first: 'Rakesh', n: 2, list: '1) Upload the BOM 2) Send the status report', slug: 'rakesh-9x2k' });
    expect(calls.single).toBeNull();
  });

  it('falls back to the combined old wording if the list template errors', async () => {
    const { svc, calls } = harness(
      [
        { id: 'r1', taskId: null, subject: 'A', message: 'm', createdAt: new Date(1) },
        { id: 'r2', taskId: null, subject: 'B', message: 'm', createdAt: new Date(2) },
      ],
    );
    (svc as any).postbox.sendTaskListTemplate = async () => ({ wamid: null, status: 'failed', error: 'not approved' });
    await svc.resendTemplate('r1');
    expect(calls.single.subject).toBe('A and B');
  });
});

describe('conversations (BEA-921)', () => {
  it('lists contacts newest-message-first with last message + a representative reminder', async () => {
    const now = Date.now();
    const prisma: any = {
      reminderMessage: {
        findMany: async () => [
          { contactId: 'k2', body: 'latest from k2', direction: 'in', createdAt: new Date(now) },
          { contactId: 'k1', body: 'older from k1', direction: 'out', createdAt: new Date(now - 100000) },
        ],
      },
      reminder: {
        findMany: async () => [
          { id: 'r1', contactId: 'k1', status: 'active', times: '["09:00"]', needsOwner: false },
          { id: 'r2', contactId: 'k2', status: 'active', times: '["10:00"]', needsOwner: true },
        ],
      },
      contact: { findMany: async () => [{ id: 'k1', name: 'Alpha', whatsappNumber: '91' }, { id: 'k2', name: 'Beta', whatsappNumber: '92' }] },
    };
    const svc = new RemindersService(prisma, {} as any, {} as any, {} as any);
    const { conversations } = await svc.conversations();
    expect(conversations.map((c: any) => c.name)).toEqual(['Beta', 'Alpha']); // newest message on top
    expect(conversations[0]).toMatchObject({ contactId: 'k2', reminderId: 'r2', needsOwner: true, activeReminderCount: 1 });
    expect(conversations[0].lastMessage).toMatchObject({ body: 'latest from k2', direction: 'in' });
    expect(conversations[1].times).toEqual(['09:00']); // parsed from JSON
  });
});

describe('conversations unread + markRead (BEA-922)', () => {
  it('counts inbound messages after lastReadAt as unread', async () => {
    const t0 = Date.now();
    const prisma: any = {
      reminderMessage: {
        findMany: async () => [
          { contactId: 'k1', body: 'new', direction: 'in', createdAt: new Date(t0) }, // after read
          { contactId: 'k1', body: 'old', direction: 'in', createdAt: new Date(t0 - 200000) }, // before read
        ],
      },
      reminder: { findMany: async () => [{ id: 'r1', contactId: 'k1', status: 'active', times: '[]', needsOwner: false }] },
      contact: { findMany: async () => [{ id: 'k1', name: 'Alpha', whatsappNumber: '91', lastReadAt: new Date(t0 - 100000) }] },
    };
    const svc = new RemindersService(prisma, {} as any, {} as any, {} as any);
    const { conversations } = await svc.conversations();
    expect(conversations[0].unread).toBe(1); // only the message after lastReadAt
  });

  it('unread counts all inbound when never read', async () => {
    const prisma: any = {
      reminderMessage: { findMany: async () => [{ contactId: 'k1', body: 'hi', direction: 'in', createdAt: new Date() }] },
      reminder: { findMany: async () => [{ id: 'r1', contactId: 'k1', status: 'active', times: '[]', needsOwner: false }] },
      contact: { findMany: async () => [{ id: 'k1', name: 'A', whatsappNumber: '9', lastReadAt: null }] },
    };
    const svc = new RemindersService(prisma, {} as any, {} as any, {} as any);
    const { conversations } = await svc.conversations();
    expect(conversations[0].unread).toBe(1);
  });

  it('markRead stamps the contact lastReadAt', async () => {
    let updated: any = null;
    const prisma: any = { contact: { update: async ({ where, data }: any) => { updated = { id: where.id, ...data }; return {}; } } };
    const svc = new RemindersService(prisma, {} as any, {} as any, {} as any);
    expect(await svc.markRead('k1')).toEqual({ ok: true });
    expect(updated.id).toBe('k1');
    expect(updated.lastReadAt instanceof Date).toBe(true);
  });
});

describe('topicFromMessage — clean nudge subject from a blank-subject message (BEA-924)', () => {
  it('strips a greeting + lead-in to the core topic', () => {
    expect(topicFromMessage('Hi Deepthi, can you please update me on the status of the PCB samples')).toBe('the status of the PCB samples');
    expect(topicFromMessage('Hello Raja - please share the install videos')).toBe('the install videos');
    expect(topicFromMessage('Hey Swathi, could you confirm the salary expectations')).toBe('the salary expectations');
  });
  it('leaves an already-clean topic alone', () => {
    expect(topicFromMessage('the socket pins report')).toBe('the socket pins report');
  });
  it('takes only the first clause and caps length', () => {
    expect(topicFromMessage('the Q3 order. Also ping me about pricing')).toBe('the Q3 order');
    expect(topicFromMessage('x'.repeat(80)).endsWith('…')).toBe(true);
  });
  it('never returns empty', () => {
    expect(topicFromMessage('')).toBe('this');
    expect(topicFromMessage('Hi Deepthi,')).toBe('this');
  });
});

/**
 * A chase that quietly does not repeat is worse than no chase — you think someone is being
 * followed up and nobody is. This asserts the flag actually reaches the database. (BEA-1021)
 */
describe('create/update persist the repeat mode (BEA-1021)', () => {
  function makeCreateSvc() {
    const rows: any[] = [];
    const prisma: any = {
      contact: { findUnique: async () => ({ id: 'c1', name: 'Ramesh' }) },
      setting: { findUnique: async () => null },
      reminder: {
        create: async ({ data }: any) => { const r = { id: 'r1', ...data }; rows.push(r); return r; },
        findUnique: async () => ({ ...rows[0], contact: { name: 'Ramesh' }, sends: [] }),
        update: async ({ data }: any) => { Object.assign(rows[0], data); return rows[0]; },
      },
      reminderSend: { deleteMany: async () => ({}), createMany: async () => ({}) },
      task: { findUnique: async () => null },
    };
    return { svc: new RemindersService(prisma, {} as any, {} as any, {} as any) as any, rows };
  }

  it('saves repeat="daily" when a chase is created', async () => {
    const { svc, rows } = makeCreateSvc();
    await svc.create({ contactId: 'c1', message: 'chase him', times: ['09:00'], repeat: 'daily' });
    expect(rows[0].repeat).toBe('daily');
  });

  it('defaults to the old one-day behaviour when nothing is asked for', async () => {
    const { svc, rows } = makeCreateSvc();
    await svc.create({ contactId: 'c1', message: 'just once', times: ['09:00'] });
    expect(rows[0].repeat).toBe('none');
  });

  it('never accepts an unknown repeat value', async () => {
    const { svc, rows } = makeCreateSvc();
    await svc.create({ contactId: 'c1', message: 'x', times: ['09:00'], repeat: 'hourly-forever' });
    expect(rows[0].repeat).toBe('none');
  });
});

/**
 * BEA-1112: rejecting a claim sent free text 27h after the contact's last reply. WhatsApp refused
 * it ("Re-engagement message") and — because the refusal only arrives later on the delivery webhook
 * — the app reported success while she heard nothing. The window is now checked BEFORE sending.
 */
describe('chatWindowOpen — the 24h rule', () => {
  const now = new Date('2026-07-25T07:15:00Z');

  it('is open just inside 24 hours', () => {
    expect(chatWindowOpen(new Date(now.getTime() - 23 * 60 * 60 * 1000), now)).toBe(true);
  });

  it('is shut just past 24 hours', () => {
    expect(chatWindowOpen(new Date(now.getTime() - 25 * 60 * 60 * 1000), now)).toBe(false);
  });

  it('is shut at exactly 24 hours', () => {
    expect(chatWindowOpen(new Date(now.getTime() - CHAT_WINDOW_MS), now)).toBe(false);
  });

  it('is shut for the real Madhuri case — last reply 24 Jul 09:36 IST, sent 25 Jul 12:45 IST', () => {
    expect(chatWindowOpen(new Date('2026-07-24T04:06:00Z'), new Date('2026-07-25T07:15:00Z'))).toBe(false);
  });

  it('is shut when they have never messaged us', () => {
    expect(chatWindowOpen(null, now)).toBe(false);
  });
});

describe('sendManual — falls back to the approved template outside the window (BEA-1112)', () => {
  function makeSvc(lastInbound: Date | null) {
    const calls: any = { text: [], template: [] };
    const prisma: any = {
      reminder: {
        findUnique: async () => ({ id: 'r1', contactId: 'c1', taskId: null, subject: 'the BOM upload', message: 'chase it', contact: { name: 'Madhuri Rao', whatsappNumber: '918019282143' } }),
        updateMany: async () => ({}),
      },
      reminderMessage: {
        findFirst: async () => (lastInbound ? { createdAt: lastInbound } : null),
        create: async ({ data }: any) => ({ id: 'm1', createdAt: new Date(), ...data }),
      },
      task: { findUnique: async () => null },
    };
    const postbox: any = {
      isConfigured: () => true,
      sendText: async (to: string, body: string) => { calls.text.push({ to, body }); return { wamid: 'w1', status: 'sent', error: null }; },
      sendReminderTemplate: async (to: string, first: string, subject: string) => { calls.template.push({ to, first, subject }); return { wamid: 'w2', status: 'sent', error: null }; },
      renderReminderTemplate: (first: string, subject: string) => `Hi ${first}, following up about ${subject}.`,
    };
    return { svc: new RemindersService(prisma, {} as any, {} as any, postbox), calls };
  }

  it('sends the free text when they replied recently', async () => {
    const { svc, calls } = makeSvc(new Date(Date.now() - 2 * 60 * 60 * 1000));
    const out: any = await svc.sendManual('r1', 'Sandeep says this is still open.');
    expect(calls.text).toHaveLength(1);
    expect(calls.template).toHaveLength(0);
    expect(out.viaTemplate).toBe(false);
    expect(out.body).toBe('Sandeep says this is still open.');
  });

  it('sends the approved template instead when the window is shut', async () => {
    const { svc, calls } = makeSvc(new Date(Date.now() - 27 * 60 * 60 * 1000));
    const out: any = await svc.sendManual('r1', 'Sandeep says this is still open.');
    expect(calls.text).toHaveLength(0); // never posts free text into a closed window
    expect(calls.template).toHaveLength(1);
    expect(calls.template[0].first).toBe('Madhuri'); // first name only
    expect(calls.template[0].subject).toBe('the BOM upload');
    expect(out.viaTemplate).toBe(true);
    expect(out.note).toMatch(/more than 24 hours/i);
  });

  it('uses the template when the contact has never replied', async () => {
    const { svc, calls } = makeSvc(null);
    const out: any = await svc.sendManual('r1', 'first contact');
    expect(calls.text).toHaveLength(0);
    expect(out.viaTemplate).toBe(true);
  });
});

/**
 * BEA-1119: a standing daily report must be asked for as today's copy. "Where does 'Send the daily
 * production update' stand?" reads like it has never been sent, when he sent one yesterday too.
 */
describe('dailySubject — asking for today\'s copy', () => {
  it('turns Jayanth\'s real titles into a natural daily ask', () => {
    expect(dailySubject('Send the daily production update')).toBe("today's production update");
    expect(dailySubject('Send the OT update')).toBe("today's OT update");
    expect(dailySubject('Share the status of hiring and work delegation')).toBe("today's status of hiring and work delegation");
  });

  it('drops a leading article without a command verb', () => {
    expect(dailySubject('The morning headcount')).toBe("today's morning headcount");
  });

  it('leaves an already-clean topic alone', () => {
    expect(dailySubject('dispatch numbers')).toBe("today's dispatch numbers");
  });

  it('never returns a bare "today\'s"', () => {
    expect(dailySubject('')).toBe("today's update");
    expect(dailySubject('   ')).toBe("today's update");
  });
});

/**
 * BEA-1226 (the Naveen case): the Message button opens the thread with the synthetic id 'thread',
 * and sending failed "Reminder not found" — both send paths insisted on a real reminder row.
 * The CONTACT is the anchor now; the latest reminder rides along when one exists.
 */
describe("the contact thread can send (BEA-1226)", () => {
  function makeThread(opts: { reminder?: any; lastIn?: Date | null } = {}) {
    const state: any = { texts: [], rows: [] };
    const prisma: any = {
      contact: { findUnique: async () => ({ id: 'c1', name: 'Naveen Kumar', whatsappNumber: '919999888877' }) },
      reminder: {
        findUnique: async () => null, // 'thread' is not a real reminder
        findFirst: async () => opts.reminder ?? null,
        findMany: async () => (opts.reminder ? [opts.reminder] : []),
        updateMany: async () => ({ count: 0 }),
      },
      reminderMessage: {
        findFirst: async () => (opts.lastIn === undefined ? { createdAt: new Date() } : opts.lastIn ? { createdAt: opts.lastIn } : null),
        create: async ({ data }: any) => { state.rows.push(data); return { id: 'm1', createdAt: new Date(), ...data }; },
      },
      task: { findUnique: async () => null },
    };
    const postbox: any = {
      isConfigured: () => true,
      sendText: async (_to: string, bodyText: string) => { state.texts.push(bodyText); return { wamid: 'w1', status: 'sent', error: null }; },
      sendReminderTemplate: async () => ({ wamid: 'w2', status: 'sent', error: null }),
      renderReminderTemplate: (f: string, s: string) => `Hi ${f}, about ${s}`,
    };
    const svc = new RemindersService(prisma, {} as any, {} as any, postbox);
    return { svc, state };
  }

  it('sends free text from the Message-button thread, anchored to the contact', async () => {
    const { svc, state } = makeThread({ reminder: { id: 'r9', contactId: 'c1', subject: 'the OT update', message: 'x' } });
    const out: any = await svc.sendManual('thread', 'How did today go?', 'c1');
    expect(out.status).toBe('sent');
    expect(state.texts).toEqual(['How did today go?']);
    expect(state.rows[0]).toMatchObject({ contactId: 'c1', reminderId: 'r9' }); // latest reminder rides along
  });

  it('works even when the contact has NO reminders at all', async () => {
    const { svc, state } = makeThread({ reminder: null });
    const out: any = await svc.sendManual('thread', 'Quick question for you', 'c1');
    expect(out.status).toBe('sent');
    expect(state.rows[0]).toMatchObject({ contactId: 'c1', reminderId: null });
  });

  it('outside the 24h window the template goes instead — same as a real reminder thread', async () => {
    const { svc, state } = makeThread({ reminder: null, lastIn: null });
    const out: any = await svc.sendManual('thread', 'Hello?', 'c1');
    expect(out.viaTemplate).toBe(true);
    expect(state.rows[0].reminderId).toBeNull();
  });

  it("a genuinely unknown reminder id with no contact still says so", async () => {
    const { svc } = makeThread();
    await expect(svc.sendManual('does-not-exist', 'x')).rejects.toThrow('Reminder not found');
  });

  it('resend-template works from the thread too', async () => {
    const { svc, state } = makeThread({ reminder: { id: 'r9', contactId: 'c1', subject: 'the OT update', message: 'x' } });
    const out: any = await svc.resendTemplate('thread', 'c1');
    expect(out.status).toBe('sent');
    expect(state.rows[0]).toMatchObject({ contactId: 'c1' });
  });
});
