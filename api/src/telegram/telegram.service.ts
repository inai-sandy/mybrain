import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorService } from '../connectors/connector.service';
import { TasksService } from '../tasks/tasks.service';
import { DailyService } from '../daily/daily.service';

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://mybrain.1site.ai';

const COMMANDS = [
  { command: 'dump', description: "Dump your brain → today's tasks" },
  { command: 'story', description: "Tell tonight's story" },
  { command: 'note', description: 'Jot a quick note' },
  { command: 'add', description: 'Add a single task' },
  { command: 'today', description: "See today's tasks" },
  { command: 'done', description: 'Mark a task done (e.g. /done 2)' },
  { command: 'help', description: 'List all commands' },
];

const HELP =
  '<b>My Brain — commands</b>\n\n' +
  '🟢 <b>Capture</b>\n' +
  '/dump — dump your brain → today\'s tasks\n' +
  '/story — tell tonight\'s story\n' +
  '/note — jot a quick note\n' +
  '/add — add a single task\n\n' +
  '🔵 <b>Check &amp; complete</b>\n' +
  '/today — see today\'s tasks\n' +
  '/done 2 — mark task #2 done\n\n' +
  'Tip: send a command alone (e.g. /dump) and I\'ll take your next message — or put it all on one line.';

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly log = new Logger('Telegram');

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorService,
    private readonly tasks: TasksService,
    private readonly daily: DailyService,
  ) {}

  async onModuleInit() {
    // If a token is already configured, make sure the webhook + command menu are registered.
    if (await this.token()) this.setup().catch((e) => this.log.warn(`setup on boot failed: ${e?.message}`));
  }

  // ---- config / settings helpers ----
  async token(): Promise<string | null> {
    const c = await this.connectors.get<{ botToken: string }>('telegram');
    return c?.botToken || process.env.TELEGRAM_BOT_TOKEN || null;
  }

  private async getSetting(key: string): Promise<string | null> {
    return (await this.prisma.setting.findUnique({ where: { key } }))?.value ?? null;
  }
  private async setSetting(key: string, value: string) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  private async secret(): Promise<string> {
    let s = await this.getSetting('telegram.secret');
    if (!s) {
      s = randomUUID().replace(/-/g, '');
      await this.setSetting('telegram.secret', s);
    }
    return s;
  }

  async ownerChatId(): Promise<string | null> {
    return this.getSetting('telegram.chatId');
  }

  private async state(): Promise<{ mode?: string; pendingText?: string }> {
    try {
      return JSON.parse((await this.getSetting('telegram.state')) || '{}');
    } catch {
      return {};
    }
  }
  private async setState(s: { mode?: string; pendingText?: string }) {
    await this.setSetting('telegram.state', JSON.stringify(s || {}));
  }

  async webhookSecret(): Promise<string> {
    return this.secret();
  }

  // ---- Telegram API ----
  private async api(method: string, body: any): Promise<any> {
    const t = await this.token();
    if (!t) return null;
    try {
      const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await r.json();
    } catch (e: any) {
      this.log.warn(`api ${method} failed: ${e?.message}`);
      return null;
    }
  }

  async send(chatId: string | number, text: string, extra: any = {}) {
    return this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }

  /** (Re)register the webhook + command menu. Returns a short status. */
  async setup(): Promise<{ ok: boolean; message: string }> {
    if (!(await this.token())) return { ok: false, message: 'No bot token set' };
    const secret = await this.secret();
    const hook = await this.api('setWebhook', {
      url: `${PUBLIC_URL}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
    await this.api('setMyCommands', { commands: COMMANDS });
    const ok = !!hook?.ok;
    return { ok, message: ok ? 'Webhook + commands registered' : `setWebhook failed: ${hook?.description || 'unknown'}` };
  }

  async status() {
    const configured = !!(await this.token());
    const owner = await this.ownerChatId();
    let webhook: any = null;
    let me: any = null;
    if (configured) {
      webhook = await this.api('getWebhookInfo', {});
      me = await this.api('getMe', {});
    }
    return {
      configured,
      linked: !!owner,
      username: me?.result?.username || null,
      webhookUrl: webhook?.result?.url || null,
      webhookOk: !!webhook?.result?.url,
      pendingUpdates: webhook?.result?.pending_update_count ?? null,
    };
  }

  /** Unlink the owner so a fresh /start can re-claim the bot. */
  async unlink() {
    await this.setSetting('telegram.chatId', '');
    await this.setState({});
    return { ok: true };
  }

  // ---- inbound update handling ----
  async handleUpdate(update: any): Promise<void> {
    try {
      // de-dupe: ignore any update id we've already processed
      const last = Number((await this.getSetting('telegram.lastUpdateId')) || 0);
      const uid = Number(update?.update_id || 0);
      if (uid && uid <= last) return;
      if (uid) await this.setSetting('telegram.lastUpdateId', String(uid));

      if (update.callback_query) return this.handleCallback(update.callback_query);
      const msg = update.message;
      if (!msg) return;
      const chatId = String(msg.chat?.id || '');
      if (!chatId) return;

      const owner = await this.ownerChatId();
      const text: string = (msg.text || '').trim();

      // ownership: first chat to /start claims the bot; everyone else is ignored
      if (!owner) {
        if (/^\/start\b/i.test(text)) {
          await this.setSetting('telegram.chatId', chatId);
          await this.send(chatId, "✅ <b>Connected.</b> This is now your private My Brain bot.\n\n" + HELP);
        } else {
          await this.send(chatId, 'Send /start to connect this chat to your My Brain.');
        }
        return;
      }
      if (chatId !== owner) {
        await this.send(chatId, '🔒 This bot is private.');
        return;
      }

      if (msg.voice || msg.audio) {
        await this.send(chatId, '🎙️ Voice notes are coming soon — please type for now.');
        return;
      }
      if (!text) return;

      if (text.startsWith('/')) return this.handleCommand(chatId, text);
      return this.handlePlain(chatId, text);
    } catch (e: any) {
      this.log.warn(`handleUpdate error: ${e?.message}`);
    }
  }

  private parse(text: string): { cmd: string; arg: string } {
    const m = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
    return { cmd: (m?.[1] || '').toLowerCase(), arg: (m?.[2] || '').trim() };
  }

  private async handleCommand(chatId: string, text: string) {
    const { cmd, arg } = this.parse(text);
    switch (cmd) {
      case 'start':
        return this.send(chatId, '✅ Already connected.\n\n' + HELP);
      case 'help':
        return this.send(chatId, HELP);
      case 'dump':
        if (arg) return this.doDump(chatId, arg);
        await this.setState({ mode: 'awaiting_dump' });
        return this.send(chatId, '🧠 Go ahead — send me everything on your mind and I\'ll turn it into today\'s tasks.');
      case 'story':
        if (arg) return this.doStory(chatId, arg);
        await this.setState({ mode: 'awaiting_story' });
        return this.send(chatId, '🌙 Tell me about your day — the problems, the wins, all of it.');
      case 'note':
        if (arg) return this.doNote(chatId, arg);
        await this.setState({ mode: 'awaiting_note' });
        return this.send(chatId, '📝 What\'s the note?');
      case 'add':
        if (arg) return this.doAdd(chatId, arg);
        await this.setState({ mode: 'awaiting_add' });
        return this.send(chatId, '➕ What task should I add?');
      case 'today':
        return this.doToday(chatId);
      case 'done':
        return this.doDone(chatId, arg);
      default:
        return this.send(chatId, `Unknown command. Try /help.`);
    }
  }

  private async handlePlain(chatId: string, text: string) {
    const st = await this.state();
    if (st.mode === 'awaiting_dump') {
      await this.setState({});
      return this.doDump(chatId, text);
    }
    if (st.mode === 'awaiting_story') {
      await this.setState({});
      return this.doStory(chatId, text);
    }
    if (st.mode === 'awaiting_note') {
      await this.setState({});
      return this.doNote(chatId, text);
    }
    if (st.mode === 'awaiting_add') {
      await this.setState({});
      return this.doAdd(chatId, text);
    }
    // no active flow → ask what they meant (buttons), remembering the text
    await this.setState({ mode: 'classify', pendingText: text });
    return this.send(chatId, '🤔 What should I do with that?', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🧠 Dump', callback_data: 'classify:dump' },
          { text: '📝 Note', callback_data: 'classify:note' },
          { text: '➕ Task', callback_data: 'classify:task' },
        ]],
      },
    });
  }

  private async handleCallback(cb: any) {
    const chatId = String(cb.message?.chat?.id || '');
    const owner = await this.ownerChatId();
    await this.api('answerCallbackQuery', { callback_query_id: cb.id });
    if (!chatId || chatId !== owner) return;
    const data: string = cb.data || '';
    const st = await this.state();
    const pending = st.pendingText || '';
    await this.setState({});
    if (!pending) return;
    if (data === 'classify:dump') return this.doDump(chatId, pending);
    if (data === 'classify:note') return this.doNote(chatId, pending);
    if (data === 'classify:task') return this.doAdd(chatId, pending);
  }

  // ---- actions ----
  private async doDump(chatId: string, text: string) {
    await this.send(chatId, '🧠 Working on it…');
    const res = await this.tasks.dump(text, 'telegram');
    if (res.question && (!res.tasks || res.tasks.length === 0)) {
      return this.send(chatId, `One question first: ${res.question}\n\nSend /dump again with a bit more detail.`);
    }
    const lines = res.tasks.map((t: any, i: number) => `${t.pinned ? '⭐️' : `${i + 1}.`} ${t.title}${t.estimateMin ? ` <i>(~${t.estimateMin}m)</i>` : ''}`);
    return this.send(chatId, `✅ <b>${res.tasks.length} task${res.tasks.length === 1 ? '' : 's'} for today:</b>\n${lines.join('\n')}\n\n/today to see them anytime.`);
  }

  private async doStory(chatId: string, text: string) {
    await this.daily.submitStory(text, 'telegram');
    return this.send(chatId, '🌙 Story saved — thanks for sharing. Sleep well.');
  }

  private async doNote(chatId: string, text: string) {
    await this.daily.addNote(text, 'telegram');
    return this.send(chatId, '📝 Noted.');
  }

  private async doAdd(chatId: string, text: string) {
    const t = await this.tasks.create({ title: text });
    if (!t) return this.send(chatId, 'Could not add that.');
    return this.send(chatId, `➕ Added: <b>${t.title}</b>`);
  }

  private async doToday(chatId: string) {
    const data = await this.tasks.today();
    if (!data.tasks.length) {
      return this.send(chatId, data.dumped ? 'All clear — no tasks today. 🎉' : 'No tasks yet. Send /dump to build today\'s list.');
    }
    const lines = data.tasks.map((t: any, i: number) => {
      const box = t.status === 'done' ? '✅' : '⬜️';
      const star = t.pinned ? '⭐️' : '';
      return `${box} <b>${i + 1}.</b> ${star}${t.title}`;
    });
    return this.send(chatId, `<b>Today — ${data.counts.done}/${data.counts.total} done</b>\n${lines.join('\n')}\n\nMark one with /done &lt;number&gt;.`);
  }

  private async doDone(chatId: string, arg: string) {
    const n = parseInt(arg, 10);
    const data = await this.tasks.today();
    if (!n || n < 1 || n > data.tasks.length) {
      return this.send(chatId, 'Which one? Use /today to see the numbers, then /done 2.');
    }
    const task = data.tasks[n - 1];
    if (task.status === 'done') return this.send(chatId, `“${task.title}” is already done. ✅`);
    await this.tasks.setDone(task.id, true);
    return this.send(chatId, `✅ Done: <b>${task.title}</b>. Nice.`);
  }
}
