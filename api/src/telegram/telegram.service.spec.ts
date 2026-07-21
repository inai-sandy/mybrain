import { TelegramService } from './telegram.service';

function make() {
  const settings: Record<string, string> = {};
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => {
        settings[where.key] = update?.value ?? create.value;
        return { key: where.key, value: settings[where.key] };
      },
    },
    task: {
      findUnique: async ({ where }: any) => ({ id: where.id, title: 'Finish proposal', note: null, status: 'open' }),
      create: jest.fn(async ({ data }: any) => ({ id: 'tr', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    brainDump: { findFirst: async () => null },
    story: { findFirst: async () => null },
    daySummary: { findUnique: async () => null },
    dayStory: { findUnique: async () => null },
    mentorDay: { findUnique: async () => null, findMany: async () => [{ day: '2026-06-10', adherenceScore: 60 }] },
  };
  const connectors: any = { get: async () => ({ botToken: 'TEST' }) };
  const tasks: any = {
    dump: jest.fn(async () => ({ question: undefined, tasks: [{ id: 't1', title: 'Finish proposal', pinned: true, estimateMin: 60 }] })),
    create: jest.fn(async (d: any) => ({ id: 'x', title: d.title })),
    today: jest.fn(async () => ({ dumped: true, counts: { done: 0, total: 1 }, tasks: [{ id: 't1', title: 'Finish proposal', status: 'open', pinned: true }] })),
    setDone: jest.fn(async () => ({ id: 't1', status: 'done' })),
    update: jest.fn(async (_id: string, d: any) => ({ id: _id, progress: d.progress, status: (d.progress ?? 0) >= 100 ? 'done' : 'open', note: d.note })),
  };
  const daily: any = {
    submitStory: jest.fn(async () => ({})),
    addNote: jest.fn(async () => ({})),
    dashboard: jest.fn(async () => ({ streak: 4, totals: { followThrough: 67, tasksDone: 8, tasksTotal: 12 }, minutesSpent: 240, categoryTime: [{ category: 'Beakn', minutes: 120 }], perDay: [{ day: '2026-06-07', done: 3 }] })),
    getPersonality: jest.fn(async () => ({ unlocked: false, daysCovered: 3, minDays: 10, summary: null, insights: [] })),
    activity: jest.fn(async () => ({ stats: { tasksDone: 1, tasksTotal: 2, minutesSpent: 25 }, summary: { text: 'You had a focused day.' }, timeline: [] })),
  };
  const items: any = { store: jest.fn(async () => ({ item: { id: 'i1' }, deduped: false })), setBookmark: jest.fn(async () => ({ ok: true })) };
  const voice: any = { transcribe: jest.fn(async () => 'transcribed text') };
  const sent: any[] = [];
  // stub the Telegram HTTP layer (some calls pass no body, e.g. fetching a URL to save)
  (global as any).fetch = jest.fn(async (_url: string, opts: any) => {
    if (opts?.body) sent.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ ok: true, result: {} }), text: async () => 'page text' };
  });
  const chat: any = { askOnce: jest.fn(async () => ({ answer: 'Here is what you saved.', sources: [] })) };
  const llm: any = { completeWith: jest.fn(async () => 'The proposal is still untouched — open it and write one paragraph now.') };
  const prompts: any = { get: async (k: string) => `[${k}]` };
  const agent: any = { getWaitpointById: jest.fn(async () => null), answerById: jest.fn(async () => ({ applied: true })) };
  return { svc: new TelegramService(prisma, connectors, tasks, daily, chat, items, voice, llm, prompts, agent), settings, prisma, tasks, daily, chat, items, voice, sent, llm };
}

describe('TelegramService', () => {
  it('claims ownership on the first /start, then ignores other chats', async () => {
    const { svc, settings, sent } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 111 }, text: '/start' } });
    expect(settings['telegram.chatId']).toBe('111');
    expect(sent.some((m) => /Connected/.test(m.text))).toBe(true);

    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 999 }, text: '/today' } });
    expect(sent.some((m) => String(m.chat_id) === '999' && /private/i.test(m.text))).toBe(true);
  });

  it('does not advance the update offset when handling throws (BEA-824)', async () => {
    const { svc, settings } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    expect(settings['telegram.lastUpdateId']).toBe('1'); // advanced after success
    // a handler error must NOT mark the message as seen (it would be permanently dropped)
    jest.spyOn(svc as any, 'processUpdate').mockRejectedValueOnce(new Error('boom'));
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: 'hi' } });
    expect(settings['telegram.lastUpdateId']).toBe('1'); // NOT advanced to 2
  });

  it('runs an inline /dump for the owner and replies with the task list', async () => {
    const { svc, tasks, sent } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/dump finish the proposal' } });
    expect(tasks.dump).toHaveBeenCalledWith('finish the proposal', 'telegram');
    expect(sent.some((m) => /1 task|Finish proposal/.test(m.text))).toBe(true);
  });

  it('captures a two-step dump: /dump then the next plain message', async () => {
    const { svc, tasks } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/dump' } });
    expect(tasks.dump).not.toHaveBeenCalled();
    await svc.handleUpdate({ update_id: 3, message: { chat: { id: 5 }, text: 'call the accountant' } });
    expect(tasks.dump).toHaveBeenCalledWith('call the accountant', 'telegram');
  });

  it('asks what a loose message means and routes the button tap', async () => {
    const { svc, daily, sent } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: 'random thought' } });
    expect(sent.some((m) => m.reply_markup)).toBe(true); // buttons shown
    await svc.handleUpdate({ update_id: 3, callback_query: { id: 'c', data: 'classify:note', message: { chat: { id: 5 } } } });
    expect(daily.addNote).toHaveBeenCalledWith('random thought', 'telegram');
  });

  it('marks a task done via /done N', async () => {
    const { svc, tasks } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/done 1' } });
    expect(tasks.setDone).toHaveBeenCalledWith('t1', true);
  });

  it('/skip sets a rest day and /snooze quiets nudges', async () => {
    const { svc, settings } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/skip' } });
    expect(settings['telegram.skipDay']).toBeTruthy();
    await svc.handleUpdate({ update_id: 3, message: { chat: { id: 5 }, text: '/snooze 30' } });
    expect(Number(settings['telegram.snoozeUntil'])).toBeGreaterThan(0);
  });

  it('/insights, /me and /activity read from the daily service', async () => {
    const { svc, daily, sent } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/insights' } });
    expect(daily.dashboard).toHaveBeenCalled();
    expect(sent.some((m) => /streak/i.test(m.text))).toBe(true);
    await svc.handleUpdate({ update_id: 3, message: { chat: { id: 5 }, text: '/me' } });
    expect(daily.getPersonality).toHaveBeenCalled();
    await svc.handleUpdate({ update_id: 4, message: { chat: { id: 5 }, text: '/activity' } });
    expect(daily.activity).toHaveBeenCalled();
  });

  it('picks a progress-aware motivation line', () => {
    const { svc } = make();
    const m = svc as any;
    expect(m.motivation({ counts: { done: 5, total: 6 }, tasks: [] })).toMatch(/crushing/i);
    expect(m.motivation({ counts: { done: 0, total: 3 }, tasks: [{ pinned: true, status: 'open', title: 'Proposal', rolloverCount: 0 }] })).toMatch(/must-do/i);
    expect(m.motivation({ counts: { done: 0, total: 2 }, tasks: [{ status: 'open', title: 'Taxes', rolloverCount: 3 }] })).toMatch(/followed you/i);
  });

  it('answers /ask by querying the brain', async () => {
    const { svc, chat } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/ask what did I save about SEO' } });
    expect(chat.askOnce).toHaveBeenCalledWith('what did I save about SEO', 'everything');
  });

  it('replying 👍 to a task reminder marks that task done', async () => {
    const { svc, settings, tasks } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    settings['telegram.msgmap'] = JSON.stringify([{ id: 777, taskId: 't1' }]);
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '👍', reply_to_message: { message_id: 777 } } });
    expect(tasks.setDone).toHaveBeenCalledWith('t1', true);
  });

  it('replying a number to a reminder sets progress; other text goes to the task note', async () => {
    const { svc, settings, tasks } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    settings['telegram.msgmap'] = JSON.stringify([{ id: 777, taskId: 't1' }]);
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '30', reply_to_message: { message_id: 777 } } });
    expect(tasks.update).toHaveBeenCalledWith('t1', { progress: 30 });
    await svc.handleUpdate({ update_id: 3, message: { chat: { id: 5 }, text: 'spoke to the vendor, waiting on a quote', reply_to_message: { message_id: 777 } } });
    expect(tasks.update).toHaveBeenCalledWith('t1', { note: 'spoke to the vendor, waiting on a quote' });
  });

  it('task reminder buttons mark done, set %, and snooze', async () => {
    const { svc, settings, tasks } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, callback_query: { id: 'a', data: 'td:t1', message: { chat: { id: 5 }, message_id: 1 } } });
    expect(tasks.setDone).toHaveBeenCalledWith('t1', true);
    await svc.handleUpdate({ update_id: 3, callback_query: { id: 'b', data: 'tp60:t1', message: { chat: { id: 5 }, message_id: 2 } } });
    expect(tasks.update).toHaveBeenCalledWith('t1', { progress: 60 });
    await svc.handleUpdate({ update_id: 4, callback_query: { id: 'c', data: 'ts30:t1', message: { chat: { id: 5 }, message_id: 3 } } });
    expect(settings['telegram.taskSnooze']).toContain('t1');
  });

  it('👍 on a dump nudge stops dump nudges for the day', async () => {
    const { svc, settings } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, callback_query: { id: 'a', data: 'akd', message: { chat: { id: 5 }, message_id: 1 } } });
    expect(settings['telegram.ack.dump']).toBeTruthy();
  });

  it('/ask shows all six scope options, then stays in the chosen scope', async () => {
    const { svc, chat, sent } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/ask' } });
    const menu = sent.find((m) => m.reply_markup?.inline_keyboard);
    const datas = menu.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(datas).toEqual(expect.arrayContaining([
      'askscope:everything', 'askscope:bookmark', 'askscope:idea', 'askscope:activity', 'askscope:document', 'askscope:skill',
    ]));
    // pick Bookmarks
    await svc.handleUpdate({ update_id: 3, callback_query: { id: 'c', data: 'askscope:bookmark', message: { chat: { id: 5 }, message_id: 1 } } });
    // now a plain message answers in that scope…
    await svc.handleUpdate({ update_id: 4, message: { chat: { id: 5 }, text: 'what did I save about pricing' } });
    expect(chat.askOnce).toHaveBeenCalledWith('what did I save about pricing', 'bookmark');
    // …and the NEXT message stays in bookmark scope (persistent)
    await svc.handleUpdate({ update_id: 5, message: { chat: { id: 5 }, text: 'and about onboarding' } });
    expect(chat.askOnce).toHaveBeenLastCalledWith('and about onboarding', 'bookmark');
  });

  it('auto-saves a bare link to the brain', async () => {
    const { svc, items } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: 'https://example.com/great-article' } });
    expect(items.store).toHaveBeenCalled();
    expect(items.store.mock.calls[0][3]).toBe('https://example.com/great-article'); // sourceUrl
  });

  it('"remind me … at 5pm" creates the task THROUGH TasksService so it reaches the brain (BEA-1018)', async () => {
    const { svc, prisma, tasks } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: 'remind me to call Sam at 5pm' } });
    // Created straight on Prisma it was never indexed, so a Telegram reminder stayed invisible to EMO.
    expect(tasks.create).toHaveBeenCalled();
    expect(prisma.task.create).not.toHaveBeenCalled();
    expect(tasks.create.mock.calls[0][0].title).toBe('call Sam');
    // …and the exact time asked for is kept (create computes its own smart times).
    expect(prisma.task.update.mock.calls[0][0].data.reminders).toContain('17:00');
  });

  it('offers a destination after saving, and "Bookmarks" reclassifies the item', async () => {
    const { svc, items, sent } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: 'https://example.com/x' } });
    expect(sent.some((m) => m.reply_markup?.inline_keyboard?.flat().some((b: any) => b.callback_data === 'dest:bm:i1'))).toBe(true);
    await svc.handleUpdate({ update_id: 3, callback_query: { id: 'c', data: 'dest:bm:i1', message: { chat: { id: 5 }, message_id: 1 } } });
    expect(items.setBookmark).toHaveBeenCalledWith('i1');
  });

  it('/exit leaves ask-mode so plain messages stop being treated as questions', async () => {
    const { svc, chat } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, callback_query: { id: 'c', data: 'askscope:bookmark', message: { chat: { id: 5 }, message_id: 1 } } });
    await svc.handleUpdate({ update_id: 3, message: { chat: { id: 5 }, text: 'first question' } });
    expect(chat.askOnce).toHaveBeenCalledTimes(1);
    await svc.handleUpdate({ update_id: 4, message: { chat: { id: 5 }, text: '/exit' } });
    await svc.handleUpdate({ update_id: 5, message: { chat: { id: 5 }, text: 'just a loose thought' } });
    expect(chat.askOnce).toHaveBeenCalledTimes(1); // no new ask after exiting
  });

  it('/week sends a weekly recap from the dashboard', async () => {
    const { svc, daily, sent } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/week' } });
    expect(daily.dashboard).toHaveBeenCalledWith(7);
    expect(sent.some((m) => /week in review/i.test(m.text))).toBe(true);
  });

  it('ignores a duplicate update_id', async () => {
    const { svc, tasks } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/dump x' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/dump x' } });
    expect(tasks.dump).toHaveBeenCalledTimes(1);
  });

  describe('daytime mentor (4 PM nudge)', () => {
    it('sends one short push with tap buttons when a pinned must-do has zero progress', async () => {
      const { svc, sent, llm } = make();
      await svc.daytimeMentor('5', '2026-06-11');
      expect(llm.completeWith).toHaveBeenCalled();
      const msg = sent.find((m) => /proposal is still untouched/i.test(m.text || ''));
      expect(msg).toBeTruthy();
      expect(JSON.stringify(msg.reply_markup)).toContain('td:t1');
    });

    it('hard-caps at 3 nudges per week', async () => {
      const { svc, settings, llm } = make();
      settings['telegram.mentorNudgeRate'] = JSON.stringify({ week: '2026-06-08', count: 3 });
      await svc.daytimeMentor('5', '2026-06-11');
      expect(llm.completeWith).not.toHaveBeenCalled();
    });

    it('stays silent when the must-dos already have progress', async () => {
      const { svc, tasks, llm } = make();
      tasks.today = jest.fn(async () => ({ dumped: true, counts: { done: 0, total: 1 }, tasks: [{ id: 't1', title: 'Finish proposal', status: 'open', pinned: true, progress: 30 }] }));
      await svc.daytimeMentor('5', '2026-06-11');
      expect(llm.completeWith).not.toHaveBeenCalled();
    });
  });

  describe('backup sync report', () => {
    it('sends a SILENT success message (3 AM — no buzz)', async () => {
      const { svc, settings, sent } = make();
      settings['telegram.chatId'] = '5';
      const r = await svc.reportBackup(true, 'My Brain + RAG, 5.6 MB');
      expect(r.sent).toBe(true);
      const msg = sent.find((m) => /Backup synced/.test(m.text));
      expect(msg).toBeTruthy();
      expect(msg.disable_notification).toBe(true);
    });

    it('sends a LOUD failure message', async () => {
      const { svc, settings, sent } = make();
      settings['telegram.chatId'] = '5';
      await svc.reportBackup(false, 'rsync: connection timed out');
      const msg = sent.find((m) => /Backup FAILED/.test(m.text));
      expect(msg).toBeTruthy();
      expect(msg.disable_notification).toBeUndefined();
      expect(msg.text).toContain('connection timed out');
    });

    it('generates the report secret once and returns the same one after', async () => {
      const { svc } = make();
      const a = await svc.backupReportSecret();
      expect(a).toHaveLength(32);
      expect(await svc.backupReportSecret()).toBe(a);
    });
  });

  describe('backup watchdog', () => {
    const fsp = require('fs/promises');
    const os = require('os');
    const path = require('path');
    async function statusFile(content: string): Promise<string> {
      const p = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'bk-')), 'backup-status.json');
      await fsp.writeFile(p, content);
      return p;
    }

    it('stays quiet when the home server pulled within 36 hours', async () => {
      const { svc } = make();
      const p = await statusFile(JSON.stringify({ lastPullAt: new Date(Date.now() - 5 * 3600_000).toISOString() }));
      expect(await svc.backupAlertText(Date.now(), p)).toBeNull();
    });

    it('alerts when the last pull is older than 36 hours', async () => {
      const { svc } = make();
      const p = await statusFile(JSON.stringify({ lastPullAt: new Date(Date.now() - 48 * 3600_000).toISOString() }));
      expect(await svc.backupAlertText(Date.now(), p)).toMatch(/Backup watchdog/);
    });

    it('alerts when the status file is missing entirely', async () => {
      const { svc } = make();
      expect(await svc.backupAlertText(Date.now(), '/nonexistent/backup-status.json')).toMatch(/may not be running/);
    });
  });
});
