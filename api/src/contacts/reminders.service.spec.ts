import { spreadTimes, localTimesToUtc, scheduleNudges, scheduleOnDay, RemindersService, looksCommandLike, stripCommandLead, sanitizeTimes } from './reminders.service';

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

describe('resendTemplate (BEA-917)', () => {
  it('sends the approved template and records the outgoing message', async () => {
    const created: any[] = [];
    const prisma: any = {
      reminder: { findUnique: async () => ({ id: 'r1', contactId: 'k1', subject: 'the update', contact: { name: 'Rakesh', whatsappNumber: '919999999999' } }) },
      reminderMessage: { create: async ({ data }: any) => { created.push(data); return { id: 'm1', ...data, createdAt: new Date() }; } },
    };
    let sentArgs: any = null;
    const postbox: any = {
      isConfigured: () => true,
      sendReminderTemplate: async (to: string, first: string, subject: string) => { sentArgs = { to, first, subject }; return { wamid: 'w9', status: 'sent', error: null }; },
      renderReminderTemplate: (f: string, s: string) => `Hi ${f}, I'm following up on behalf of Sandeep about ${s}. Could you let him know where it stands? A quick tap below is enough.`,
    };
    const svc = new RemindersService(prisma, {} as any, {} as any, postbox);
    const res: any = await svc.resendTemplate('r1');
    expect(sentArgs).toEqual({ to: '919999999999', first: 'Rakesh', subject: 'the update' });
    expect(res.status).toBe('sent');
    expect(created[0]).toMatchObject({ direction: 'out', wamid: 'w9', status: 'sent' });
    expect(created[0].body).toContain('following up on behalf of Sandeep about the update');
  });
});
