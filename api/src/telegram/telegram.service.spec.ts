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
    task: { findUnique: async ({ where }: any) => ({ id: where.id, title: 'Finish proposal', note: null, status: 'open' }) },
    brainDump: { findFirst: async () => null },
    story: { findFirst: async () => null },
    daySummary: { findUnique: async () => null },
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
    dashboard: jest.fn(async () => ({ streak: 4, totals: { followThrough: 67, tasksDone: 8, tasksTotal: 12 }, minutesSpent: 240, categoryTime: [{ category: 'Beakn', minutes: 120 }] })),
    getPersonality: jest.fn(async () => ({ unlocked: false, daysCovered: 3, minDays: 10, summary: null, insights: [] })),
    activity: jest.fn(async () => ({ stats: { tasksDone: 1, tasksTotal: 2, minutesSpent: 25 }, summary: { text: 'You had a focused day.' }, timeline: [] })),
  };
  const sent: any[] = [];
  // stub the Telegram HTTP layer
  (global as any).fetch = jest.fn(async (_url: string, opts: any) => {
    sent.push(JSON.parse(opts.body));
    return { json: async () => ({ ok: true, result: {} }) };
  });
  const chat: any = { askOnce: jest.fn(async () => ({ answer: 'Here is what you saved.', sources: [] })) };
  return { svc: new TelegramService(prisma, connectors, tasks, daily, chat), settings, tasks, daily, chat, sent };
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

  it('ignores a duplicate update_id', async () => {
    const { svc, tasks } = make();
    await svc.handleUpdate({ update_id: 1, message: { chat: { id: 5 }, text: '/start' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/dump x' } });
    await svc.handleUpdate({ update_id: 2, message: { chat: { id: 5 }, text: '/dump x' } });
    expect(tasks.dump).toHaveBeenCalledTimes(1);
  });
});
