import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorService } from '../connectors/connector.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TasksService } from '../tasks/tasks.service';
import { DailyService } from '../daily/daily.service';
import { ChatService } from '../chat/chat.service';
import { ItemsService } from '../items/items.service';
import { VoiceService } from '../voice/voice.service';

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://mybrain.1site.ai';

const COMMANDS = [
  { command: 'dump', description: "Dump your brain → today's tasks" },
  { command: 'story', description: "Tell tonight's story" },
  { command: 'note', description: 'Jot a quick note' },
  { command: 'add', description: 'Add a single task' },
  { command: 'today', description: "See today's tasks" },
  { command: 'done', description: 'Mark a task done (e.g. /done 2)' },
  { command: 'ask', description: 'Ask your brain / memory anything' },
  { command: 'save', description: 'Save a link, text or file to your brain' },
  { command: 'insights', description: 'Streak, follow-through, time' },
  { command: 'week', description: 'Your week in review' },
  { command: 'me', description: 'Your personality snapshot' },
  { command: 'activity', description: "Today's summary" },
  { command: 'exit', description: 'Leave the current mode (e.g. /ask)' },
  { command: 'skip', description: 'Rest day — mute nudges today' },
  { command: 'snooze', description: 'Quiet nudges for a while' },
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
  '/done 2 — mark task #2 done\n' +
  '/ask — ask your brain (pick a subject, stays there)\n' +
  '/save — save a link / text / file to your brain\n' +
  '/activity — today\'s summary\n' +
  '/insights — streak, follow-through, time\n' +
  '/week — your week in review\n' +
  '/me — your personality snapshot\n\n' +
  '✨ <b>Just send me a link</b> and I\'ll save it. Say <i>“remind me to call Sam at 5pm”</i> and I\'ll set the reminder.\n\n' +
  '⚙️ <b>Control</b>\n' +
  '/exit — leave the current mode (e.g. /ask)\n' +
  '/skip — rest day (no nudges today)\n' +
  '/snooze — quiet nudges for an hour\n\n' +
  '💡 <b>On a task reminder</b> you can tap the buttons (✅ Done · 30% · 60% · 🔕 Snooze), or just <b>reply</b> to it: 👍 = done, a number (30/60) = progress, or any text/voice note → saved to that task.\n\n' +
  'Tip: send a command alone (e.g. /dump) and I\'ll take your next message or voice note — or put it all on one line.';

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly log = new Logger('Telegram');

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorService,
    private readonly tasks: TasksService,
    private readonly daily: DailyService,
    private readonly chat: ChatService,
    private readonly items: ItemsService,
    private readonly voice: VoiceService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  async onModuleInit() {
    // If a token is already configured, make sure the webhook + command menu are registered.
    if (await this.token()) this.setup().catch((e) => this.log.warn(`setup on boot failed: ${e?.message}`));
    // Outbound nudges: morning dump, evening story, task reminders, mid-day motivation, nightly summary.
    setInterval(() => this.nudgeTick().catch((e) => this.log.warn(`nudgeTick: ${e?.message}`)), 60_000);
  }

  // ---- time helpers (user timezone) ----
  private async tz(): Promise<string> {
    return (await this.getSetting('tasks.tz')) || 'Asia/Kolkata';
  }
  private dayKey(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }
  private localHM(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    } catch {
      return d.toISOString().slice(11, 16);
    }
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

  /** Shared secret gating POST /telegram/backup-report (generated once, also stored on the home server). */
  async backupReportSecret(): Promise<string> {
    let s = await this.getSetting('backup.reportSecret');
    if (!s) {
      s = randomUUID().replace(/-/g, '');
      await this.setSetting('backup.reportSecret', s);
    }
    return s;
  }

  private async state(): Promise<{ mode?: string; pendingText?: string; scope?: string }> {
    try {
      return JSON.parse((await this.getSetting('telegram.state')) || '{}');
    } catch {
      return {};
    }
  }
  private async setState(s: { mode?: string; pendingText?: string; scope?: string }) {
    await this.setSetting('telegram.state', JSON.stringify(s || {}));
  }

  // Chat scopes shown by /ask — matches the web app's "talk to your brain" scopes.
  private readonly ASK_SCOPES: Record<string, string> = {
    everything: '🌐 Everything',
    bookmark: '🔖 Bookmarks',
    idea: '💡 Ideas',
    activity: '📊 Activity',
    document: '📥 Capture',
    skill: '🪄 Skills',
  };
  private askScopeKeyboard() {
    return {
      inline_keyboard: [
        [{ text: '🌐 Everything', callback_data: 'askscope:everything' }],
        [{ text: '🔖 Bookmarks', callback_data: 'askscope:bookmark' }, { text: '💡 Ideas', callback_data: 'askscope:idea' }],
        [{ text: '📊 Activity', callback_data: 'askscope:activity' }, { text: '📥 Capture', callback_data: 'askscope:document' }],
        [{ text: '🪄 Skills', callback_data: 'askscope:skill' }],
      ],
    };
  }

  // ---- reminder acknowledgement: message→task map, per-task snooze, nudge acks ----
  /** Inline buttons attached to a task reminder. */
  private taskKeyboard(taskId: string) {
    return {
      inline_keyboard: [
        [
          { text: '✅ Done', callback_data: `td:${taskId}` },
          { text: '30%', callback_data: `tp30:${taskId}` },
          { text: '60%', callback_data: `tp60:${taskId}` },
        ],
        [
          { text: '🔕 30m', callback_data: `ts30:${taskId}` },
          { text: '🔕 2h', callback_data: `ts120:${taskId}` },
          { text: '🔕 tmrw', callback_data: `tstm:${taskId}` },
        ],
      ],
    };
  }

  /** Remember which task a reminder message belongs to, so a reply to it updates that task. */
  private async msgMap(): Promise<{ id: number; taskId: string }[]> {
    try {
      return JSON.parse((await this.getSetting('telegram.msgmap')) || '[]');
    } catch {
      return [];
    }
  }
  private async recordTaskMsg(res: any, taskId: string) {
    const id = res?.result?.message_id;
    if (!id) return;
    const map = await this.msgMap();
    map.push({ id, taskId });
    await this.setSetting('telegram.msgmap', JSON.stringify(map.slice(-120)));
  }
  private async lookupTaskMsg(messageId: number): Promise<string | null> {
    return (await this.msgMap()).find((m) => m.id === messageId)?.taskId || null;
  }

  private async taskSnooze(): Promise<Record<string, number>> {
    try {
      return JSON.parse((await this.getSetting('telegram.taskSnooze')) || '{}');
    } catch {
      return {};
    }
  }
  private async snoozeTask(taskId: string, untilTs: number) {
    const m = await this.taskSnooze();
    m[taskId] = untilTs;
    await this.setSetting('telegram.taskSnooze', JSON.stringify(m));
  }
  private async isTaskSnoozed(taskId: string): Promise<boolean> {
    const m = await this.taskSnooze();
    return !!m[taskId] && Date.now() < m[taskId];
  }

  private async ackedToday(kind: string, day: string): Promise<boolean> {
    return (await this.getSetting(`telegram.ack.${kind}`)) === day;
  }
  private async ackToday(kind: string, day: string) {
    await this.setSetting(`telegram.ack.${kind}`, day);
  }

  /** Minutes from local midnight (used to compute "rest of today" snooze). */
  private minsIntoDay(tz: string): number {
    const [h, m] = this.localHM(tz).split(':').map(Number);
    return h * 60 + m;
  }

  private async editMsg(chatId: string, messageId: number, text: string) {
    return this.api('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  }

  /** Apply a reply/voice-note aimed at a specific task: 👍→done, a number→%, anything else→note. */
  private async applyTaskReply(chatId: string, taskId: string, body: string) {
    const t = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!t) return this.send(chatId, 'That task is no longer on your list.');
    const b = (body || '').trim();
    if (!b) return;
    if (/^(👍|👍🏻|👍🏼|done|ok|okay|okey|yes|yep|✅|✔️|finished|complete|completed|did it)$/i.test(b)) {
      await this.tasks.setDone(taskId, true);
      return this.send(chatId, `✅ Marked done: <b>${this.esc(t.title)}</b>. Nice.`);
    }
    const num = b.match(/^(\d{1,3})\s*%?$/);
    if (num) {
      const pct = Math.max(0, Math.min(100, parseInt(num[1], 10)));
      const upd = await this.tasks.update(taskId, { progress: pct });
      if ((upd?.progress ?? pct) >= 100 || upd?.status === 'done') return this.send(chatId, `✅ Marked done: <b>${this.esc(t.title)}</b>.`);
      return this.send(chatId, `◐ <b>${this.esc(t.title)}</b> — ${upd?.progress ?? pct}% done.`);
    }
    const note = (t.note ? t.note + '\n' : '') + b;
    await this.tasks.update(taskId, { note });
    return this.send(chatId, `📝 Added to <b>${this.esc(t.title)}</b>'s notes:\n<i>${this.esc(b.slice(0, 300))}</i>`);
  }

  /** 7 AM: one tidy briefing of today's must-dos, each with a tap-to-complete button. */
  private async morningBriefing(owner: string) {
    const data = await this.tasks.today();
    const open = data.tasks.filter((t: any) => t.status === 'open');
    if (!open.length) {
      const text = data.dumped ? '☀️ <b>Good morning!</b> Nothing on today\'s list yet — clear runway. /dump to plan it.' : '☀️ <b>Good morning, Sandeep!</b> What\'s on your plate today?';
      return this.send(owner, text, { reply_markup: { inline_keyboard: [[{ text: '🧠 Dump my brain', callback_data: 'acd' }]] } });
    }
    const pinned = open.filter((t: any) => t.pinned);
    const focus = (pinned.length ? pinned : open).slice(0, 5);
    const lines = focus.map((t: any, i: number) => `${t.pinned ? '⭐️' : `${i + 1}.`} ${this.esc(t.title)}${t.estimateMin ? ` <i>(~${t.estimateMin}m)</i>` : ''}`);
    const rows = focus.map((t: any) => [{ text: `✅ ${t.title.slice(0, 28)}`, callback_data: `td:${t.id}` }]);
    return this.send(owner, `☀️ <b>Good morning! Today's focus — ${data.counts.done}/${data.counts.total} done</b>\n${lines.join('\n')}\n\n<i>Tap to complete, or reply to any reminder later.</i>`, { reply_markup: { inline_keyboard: rows } });
  }

  /** 9 PM: what's still open with Done buttons + a one-tap prompt to tell tonight's story. */
  private async eveningCheckin(owner: string) {
    const data = await this.tasks.today();
    const open = data.tasks.filter((t: any) => t.status === 'open');
    const storyRow = [{ text: '🌙 Tell tonight\'s story', callback_data: 'acs' }];
    if (!open.length) {
      return this.send(owner, `🌆 <b>Evening check-in</b>\nEverything done — ${data.counts.done}/${data.counts.total}. 🎉\n\nHow did the day really feel?`, { reply_markup: { inline_keyboard: [storyRow] } });
    }
    const lines = open.slice(0, 6).map((t: any) => `• ${this.esc(t.title)}${(t.progress || 0) > 0 ? ` <i>(${t.progress}%)</i>` : ''}`);
    const rows = open.slice(0, 6).map((t: any) => [{ text: `✅ ${t.title.slice(0, 28)}`, callback_data: `td:${t.id}` }]);
    rows.push(storyRow);
    return this.send(owner, `🌆 <b>Evening check-in — ${open.length} still open</b>\n${lines.join('\n')}\n\n<i>Close what you can, then tell tonight's story.</i>`, { reply_markup: { inline_keyboard: rows } });
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

      // Reply to a task reminder → update THAT task (👍=done · number=% · text/voice→note).
      const replyId = msg.reply_to_message?.message_id;
      if (replyId) {
        const taskId = await this.lookupTaskMsg(Number(replyId));
        if (taskId) {
          let body = text;
          if (msg.voice || msg.audio) {
            body = (await this.transcribe(msg.voice?.file_id || msg.audio?.file_id)) || '';
            if (body) await this.send(chatId, `🎙️ <i>${this.esc(body.slice(0, 200))}</i>`);
          }
          return this.applyTaskReply(chatId, taskId, body);
        }
      }

      if (msg.voice || msg.audio) {
        const fileId = msg.voice?.file_id || msg.audio?.file_id;
        const transcript = await this.transcribe(fileId);
        if (!transcript) {
          await this.send(chatId, '🎙️ Couldn\'t transcribe that — add a valid OpenAI key (Settings → Integrations) or type it instead.');
          return;
        }
        await this.send(chatId, `🎙️ <i>${transcript.slice(0, 200)}</i>`);
        return this.handlePlain(chatId, transcript);
      }

      // A file or photo → save it to the brain.
      if (msg.document || msg.photo) {
        return this.handleIncomingFile(chatId, msg);
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
      case 'ask': {
        // Always let the user pick a subject first; the chat then stays in that scope.
        const cur = (await this.state()).scope;
        if (arg) return this.doAsk(chatId, arg, cur || 'everything');
        return this.send(chatId, '🧠 <b>Ask your brain</b> — which part do you want to talk to?', { reply_markup: this.askScopeKeyboard() });
      }
      case 'save':
        if (arg) return this.doSave(chatId, arg);
        await this.setState({ mode: 'awaiting_save' });
        return this.send(chatId, '📥 Send me a link, some text, or a file and I\'ll save it to your brain.');
      case 'activity':
        return this.doActivity(chatId);
      case 'insights':
      case 'stats':
        return this.doInsights(chatId);
      case 'week':
        return this.doWeek(chatId);
      case 'me':
        return this.doMe(chatId);
      case 'exit':
      case 'cancel':
      case 'stop': {
        const had = (await this.state()).mode;
        await this.setState({});
        return this.send(chatId, had ? '👌 Exited. Back to normal — send /help for commands.' : 'Nothing to exit — send /help for commands.');
      }
      case 'skip':
        return this.doSkip(chatId);
      case 'snooze':
        return this.doSnooze(chatId, arg);
      default:
        return this.send(chatId, `Unknown command. Try /help.`);
    }
  }

  private async handlePlain(chatId: string, text: string) {
    const st = await this.state();
    // Persistent ask-mode: every plain message keeps answering in the chosen scope until /ask switches it.
    if (st.mode === 'ask') {
      return this.doAsk(chatId, text, st.scope || 'everything');
    }
    if (st.mode === 'awaiting_save') {
      await this.setState({});
      return this.doSave(chatId, text);
    }
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
    if (st.mode === 'awaiting_ask') {
      await this.setState({});
      return this.doAsk(chatId, text);
    }

    // "remind me to X at 5pm" → create the task with that reminder
    if (/^\s*remind me\b/i.test(text)) {
      const r = await this.createReminder(text);
      if (r) return this.send(chatId, `⏰ Reminder set: <b>${this.esc(r.title)}</b> at <b>${r.hm}</b>${r.tomorrow ? ' (tomorrow)' : ''}.`);
    }

    // a bare link → save it to the brain
    const url = this.firstUrl(text);
    if (url) return this.doSave(chatId, text);

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
    if (!chatId || chatId !== owner) {
      await this.api('answerCallbackQuery', { callback_query_id: cb.id });
      return;
    }
    const data: string = cb.data || '';
    const msgId = cb.message?.message_id;
    const tz = await this.tz();
    const day = this.dayKey(tz);

    const ack = (text?: string) => this.api('answerCallbackQuery', { callback_query_id: cb.id, text });

    // --- task reminder actions ---
    const taskAction = data.match(/^(td|tp30|tp60|ts30|ts120|tstm):(.+)$/);
    if (taskAction) {
      const [, action, taskId] = taskAction;
      const t = await this.prisma.task.findUnique({ where: { id: taskId } });
      if (!t) { await ack('Task is gone'); return; }
      const title = this.esc(t.title);
      if (action === 'td') {
        await this.tasks.setDone(taskId, true);
        await ack('Done ✅');
        if (msgId) await this.editMsg(chatId, msgId, `✅ <b>${title}</b> — done. Nice.`);
        return;
      }
      if (action === 'tp30' || action === 'tp60') {
        const pct = action === 'tp30' ? 30 : 60;
        await this.tasks.update(taskId, { progress: pct });
        await ack(`Marked ${pct}%`);
        if (msgId) await this.editMsg(chatId, msgId, `◐ <b>${title}</b> — ${pct}% done. Keep going.`);
        return;
      }
      // snooze
      const mins = action === 'ts30' ? 30 : action === 'ts120' ? 120 : (1440 - this.minsIntoDay(tz)) + 360; // tmrw ≈ until ~6 AM
      await this.snoozeTask(taskId, Date.now() + mins * 60_000);
      const label = action === 'ts30' ? '30 min' : action === 'ts120' ? '2 hours' : 'tomorrow';
      await ack(`Snoozed ${label}`);
      if (msgId) await this.editMsg(chatId, msgId, `🔕 <b>${title}</b> — snoozed until ${label}.`);
      return;
    }

    // --- nudge acknowledgements / quick actions ---
    if (data === 'akd') { await this.ackToday('dump', day); await ack('Got it 👍'); if (msgId) await this.editMsg(chatId, msgId, '👍 No more dump nudges today.'); return; }
    if (data === 'aks') { await this.ackToday('story', day); await ack('Got it 👍'); if (msgId) await this.editMsg(chatId, msgId, '👍 No more story nudges today.'); return; }
    if (data === 'acd') { await ack(); await this.setState({ mode: 'awaiting_dump' }); return this.send(chatId, '🧠 Go ahead — send everything on your mind (type or voice) and I\'ll build today\'s tasks.'); }
    if (data === 'acs') { await ack(); await this.setState({ mode: 'awaiting_story' }); return this.send(chatId, '🌙 Tell me about your day — the problems, the wins, all of it (type or voice).'); }

    // --- save destination chooser: Bookmarks vs Capture ---
    if (data.startsWith('dest:')) {
      const [, dest, id] = data.split(':');
      if (dest === 'bm') {
        await this.items.setBookmark(id).catch(() => null);
        await ack('Moved to Bookmarks 🔖');
        if (msgId) await this.editMsg(chatId, msgId, '🔖 Filed under <b>Bookmarks</b>.');
      } else {
        await ack('Kept in Capture 📥');
        if (msgId) await this.editMsg(chatId, msgId, '📥 Kept in <b>Capture</b>.');
      }
      return;
    }

    // --- /ask scope picker: enter persistent ask-mode in the chosen scope ---
    if (data.startsWith('askscope:')) {
      const scope = data.slice('askscope:'.length);
      const label = this.ASK_SCOPES[scope] || '🌐 Everything';
      await this.setState({ mode: 'ask', scope });
      await ack(`Now asking ${label}`);
      return this.send(chatId, `${label} — ask away. Every message now answers from your <b>${label.replace(/^\S+\s/, '')}</b>.\n\n<i>/ask to switch subject · /exit to leave.</i>`);
    }

    // --- "what should I do with that?" classifier ---
    await ack();
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

  private async doActivity(chatId: string) {
    const a = await this.daily.activity();
    const lines = [`<b>Today — ${a.stats.tasksDone}/${a.stats.tasksTotal} done · ${a.stats.minutesSpent}m</b>`];
    if (a.summary) {
      lines.push('', a.summary.text);
    } else {
      lines.push('', '<i>Summary auto-writes at 9:30 PM. So far today:</i>');
      lines.push(...a.timeline.slice(0, 8).map((e: any) => `• ${e.title}`));
      if (!a.timeline.length) lines.push('• nothing yet');
    }
    return this.send(chatId, lines.join('\n'));
  }

  private async doInsights(chatId: string) {
    const d = await this.daily.dashboard(30);
    const cats = d.categoryTime.slice(0, 3).map((c: any) => `${c.category} ${Math.round(c.minutes)}m`).join(', ') || 'n/a';
    return this.send(
      chatId,
      `<b>Last 30 days</b>\n🔥 Dump streak: <b>${d.streak}</b>\n✅ Follow-through: <b>${d.totals.followThrough}%</b> (${d.totals.tasksDone}/${d.totals.tasksTotal})\n⏱ Time logged: <b>${d.minutesSpent}m</b>\n📊 Top: ${cats}`,
    );
  }

  private async doMe(chatId: string) {
    const p = await this.daily.getPersonality();
    if (!p.unlocked) return this.send(chatId, `🔍 Still getting to know you — <b>${p.daysCovered}/${p.minDays}</b> active days. Your portrait unlocks at ${p.minDays}.`);
    const lines = [p.summary || 'Building your portrait…'];
    if (p.insights.length) lines.push('', ...p.insights.slice(0, 5).map((i: any) => `• <b>${i.dimension}:</b> ${i.claim}`));
    return this.send(chatId, lines.join('\n'));
  }

  private esc(s: string): string {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  private mdToHtml(s: string): string {
    let t = this.esc(s);
    t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>').replace(/^\s*[-*]\s+/gm, '• ');
    return t;
  }

  /** /ask — query a chosen slice of the user's brain, reply with the answer + sources. Scope persists. */
  private async doAsk(chatId: string, question: string, scope = 'everything') {
    const label = this.ASK_SCOPES[scope] || '🌐 Everything';
    await this.send(chatId, `🧠 Searching your ${label}…`);
    const { answer, sources } = await this.chat.askOnce(question, scope);
    let msg = this.mdToHtml((answer || "I don't have anything saved about that.").slice(0, 3500));
    if (sources?.length) {
      const links = sources.slice(0, 5).map((s) => {
        const url = s.url || (s.itemId ? `${PUBLIC_URL}/doc/${s.itemId}` : '');
        return '• ' + (url ? `<a href="${url}">${this.esc(s.title)}</a>` : this.esc(s.title));
      });
      msg += '\n\n<b>Sources</b>\n' + links.join('\n');
    }
    return this.send(chatId, msg);
  }

  private async doSkip(chatId: string) {
    await this.setSetting('telegram.skipDay', this.dayKey(await this.tz()));
    return this.send(chatId, '🌴 Rest day — no nudges today. See you tomorrow.');
  }

  private async doSnooze(chatId: string, arg: string) {
    const mins = Math.max(5, Math.min(720, parseInt(arg, 10) || 60));
    await this.setSetting('telegram.snoozeUntil', String(Date.now() + mins * 60_000));
    return this.send(chatId, `🔕 Nudges quiet for ${mins} minutes.`);
  }

  private dayAdd(day: string, n: number): string {
    const d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // ---- save anything to the brain ----
  private firstUrl(text: string): string | null {
    const m = (text || '').match(/https?:\/\/[^\s]+/i);
    return m ? m[0] : null;
  }
  private titleFromUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? ' — saved page' : '');
    } catch {
      return url.slice(0, 60);
    }
  }

  /** Confirm a save and offer to file it under Bookmarks vs Capture. */
  private async confirmSaved(chatId: string, res: any, what: string) {
    if (!res) return this.send(chatId, 'Could not save that.');
    if (res.deduped) return this.send(chatId, '✓ Already in your brain.');
    const id = res.item?.id;
    return this.send(chatId, `📥 Saved to <b>Capture</b>: ${what}\n<i>Where should this live?</i>`, id ? {
      reply_markup: { inline_keyboard: [[{ text: '🔖 Move to Bookmarks', callback_data: `dest:bm:${id}` }, { text: '✓ Keep in Capture', callback_data: `dest:cap:${id}` }]] },
    } : {});
  }

  private async doSave(chatId: string, text: string) {
    const url = this.firstUrl(text);
    if (url) {
      await this.send(chatId, '🔗 Saving the link…');
      let content = url;
      try {
        const r = await fetch(url);
        if (r.ok) content = (await r.text()).slice(0, 200000);
      } catch {
        /* keep the url itself as content */
      }
      const title = text.replace(url, '').trim().slice(0, 80) || this.titleFromUrl(url);
      const res = await this.items.store(content, 'telegram-url', title, url).catch(() => null);
      return this.confirmSaved(chatId, res, `<a href="${url}">${this.esc(title)}</a>`);
    }
    const content = (text || '').trim();
    if (content.length < 2) return this.send(chatId, 'Send a link, some text, or a file to save.');
    await this.send(chatId, '📥 Saving…');
    const title = content.split('\n')[0].slice(0, 80);
    const res = await this.items.store(content, 'telegram', title).catch(() => null);
    return this.confirmSaved(chatId, res, `<b>${this.esc(title)}</b>`);
  }

  private async handleIncomingFile(chatId: string, msg: any) {
    const caption = (msg.caption || '').trim();
    // Photo → read it with vision, save the text/description.
    if (msg.photo?.length) {
      await this.send(chatId, '🖼️ Reading the image…');
      const fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
      const buf = await this.downloadFile(fileId);
      const read = buf ? await this.visionRead(buf, 'image/jpeg').catch(() => null) : null;
      if (!read && !caption) return this.send(chatId, '🖼️ I couldn\'t read text from that image. Add a caption and I\'ll save that.');
      const body = [caption, read].filter(Boolean).join('\n\n');
      const title = (caption || (read || '').split('\n')[0] || 'Image note').slice(0, 80);
      const res = await this.items.store(body, 'telegram-image', title).catch(() => null);
      return this.confirmSaved(chatId, res, `🖼️ <b>${this.esc(title)}</b>`);
    }
    const doc = msg.document;
    if (!doc) return;
    const name = doc.file_name || 'file';
    const mime = doc.mime_type || '';
    if (/\.(md|markdown|txt|csv|json)$/i.test(name) || /^text\//.test(mime) || mime === 'application/json') {
      await this.send(chatId, '📄 Saving the file…');
      const buf = await this.downloadFile(doc.file_id);
      const content = buf ? buf.toString('utf8').slice(0, 300000) : '';
      if (!content) return this.send(chatId, 'Could not read that file.');
      const res = await this.items.store(content, 'telegram-file', name.replace(/\.[^.]+$/, '').slice(0, 80)).catch(() => null);
      return this.confirmSaved(chatId, res, `📄 <b>${this.esc(name)}</b>`);
    }
    // Other types (PDF, etc.) → keep the caption + filename so nothing's lost.
    const body = [caption, `File: ${name} (${mime})`].filter(Boolean).join('\n');
    const res = await this.items.store(body, 'telegram-file', (caption || name).slice(0, 80)).catch(() => null);
    if (res && !res.deduped) await this.send(chatId, '<i>(Links, text, images & .txt/.md are read in full; deep PDF reading is coming.)</i>');
    return this.confirmSaved(chatId, res, `📎 <b>${this.esc(name)}</b>`);
  }

  private async downloadFile(fileId: string): Promise<Buffer | null> {
    const t = await this.token();
    if (!t) return null;
    const f = await this.api('getFile', { file_id: fileId });
    const path = f?.result?.file_path;
    if (!path) return null;
    try {
      const r = await fetch(`https://api.telegram.org/file/bot${t}/${path}`);
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch {
      return null;
    }
  }

  private async visionRead(buf: Buffer, mime: string): Promise<string | null> {
    const or = await this.connectors.get<{ apiKey: string }>('openrouter');
    if (!or?.apiKey) return null;
    const body = {
      model: 'google/gemini-3-flash-preview',
      max_tokens: 1200,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Extract all text from this image verbatim. If there is little text, briefly describe what it shows. Output only the result.' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
      ] }],
    };
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${or.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    const d: any = await r.json();
    const text = d?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  }

  // ---- natural-language reminder: "remind me to call Sam at 5pm" ----
  async createReminder(text: string): Promise<{ title: string; hm: string; tomorrow: boolean } | null> {
    const tz = await this.tz();
    let body = text.replace(/^\s*remind me\s*/i, '').trim();
    let tomorrow = /\btomorrow\b/i.test(body);
    body = body.replace(/\btomorrow\b/i, '').trim();
    let hm: string | null = null;

    const rel = body.match(/\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i);
    if (rel) {
      const n = parseInt(rel[1], 10);
      const isHour = /hour|hr/i.test(rel[2]);
      let total = this.minsIntoDay(tz) + (isHour ? n * 60 : n);
      if (total >= 1440) { total -= 1440; tomorrow = true; }
      hm = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      body = body.replace(rel[0], '').trim();
    }
    if (!hm) {
      const at = body.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i) || body.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
      if (at) {
        let h = parseInt(at[1], 10);
        const min = at[2] ? parseInt(at[2], 10) : 0;
        const mer = (at[3] || '').toLowerCase();
        if (mer === 'pm' && h < 12) h += 12;
        if (mer === 'am' && h === 12) h = 0;
        if (!mer && h >= 1 && h <= 7) h += 12; // bare "at 5" → assume evening
        hm = `${String(Math.min(23, h)).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        body = body.replace(at[0], '').trim();
      }
    }
    if (!hm) return null;

    let title = body.replace(/^to\s+/i, '').replace(/[\s,]+$/, '').trim().slice(0, 160) || 'Reminder';
    const day = tomorrow ? this.dayAdd(this.dayKey(tz), 1) : this.dayKey(tz);
    await this.prisma.task.create({ data: { title, day, reminderCount: 1, reminders: JSON.stringify([hm]), priority: 'medium' } });
    return { title, hm, tomorrow };
  }

  private async doWeek(chatId: string) {
    const d = await this.daily.dashboard(7);
    const cats = d.categoryTime.slice(0, 3).map((c: any) => `${c.category} ${Math.round(c.minutes)}m`).join(', ') || 'n/a';
    const best = d.perDay.reduce((a: any, b: any) => (b.done > (a?.done ?? -1) ? b : a), null);
    return this.send(
      chatId,
      `<b>📅 Your week in review</b>\n🔥 Dump streak: <b>${d.streak}</b>\n✅ Follow-through: <b>${d.totals.followThrough}%</b> (${d.totals.tasksDone}/${d.totals.tasksTotal})\n⏱ Time logged: <b>${d.minutesSpent}m</b>\n📊 Top areas: ${cats}${best && best.done ? `\n🏆 Best day: ${best.day} (${best.done} done)` : ''}`,
    );
  }

  /** Deliver the nightly Story of the Day + Mentor read to Telegram (flags set by those engines). */
  private async pushPending(owner: string) {
    const sDay = await this.getSetting('telegram.pushStory');
    if (sDay) {
      await this.setSetting('telegram.pushStory', '');
      const ds = await this.prisma.dayStory.findUnique({ where: { day: sDay } });
      if (ds?.text) {
        const pers = (ds as any).personalText;
        const body = pers
          ? `💼 <b>Professional</b>${(ds as any).proMoodScore != null ? ` · ${(ds as any).proMoodScore}/100` : ''}\n${this.esc(ds.text).slice(0, 1800)}\n\n🏠 <b>Personal</b>${(ds as any).personalMoodScore != null ? ` · ${(ds as any).personalMoodScore}/100` : ''}\n${this.esc(pers).slice(0, 1800)}`
          : this.esc(ds.text).slice(0, 3800);
        await this.send(owner, `🌙 <b>Story of the Day</b>${ds.moodScore != null ? ` · mood ${ds.moodScore}/100` : ''}\n\n${body}`);
      }
    }
    const rDay = await this.getSetting('telegram.pushStoryReminder');
    if (rDay) {
      await this.setSetting('telegram.pushStoryReminder', '');
      // Only nudge if the day is still open (the user may have told the story between 10:00 and now).
      const closed = await this.prisma.dayClose.findUnique({ where: { day: rDay } });
      const told = await this.prisma.story.findFirst({ where: { day: rDay } });
      if (!closed && !told) {
        await this.send(owner, `📖 <b>Yesterday's story?</b>\nTell me how ${rDay} went and I'll wrap it up — your Mentor and the Lab update once it's in.`, {
          reply_markup: { inline_keyboard: [[{ text: '📖 Tell the story', url: `${PUBLIC_URL}/today` }]] },
        });
      }
    }
    const mDay = await this.getSetting('telegram.pushMentor');
    if (mDay) {
      await this.setSetting('telegram.pushMentor', '');
      // "Insights pull, not push" (BEA-527): the note is always in the app; only push it if the user wants the ping.
      const mentorPush = (await this.getSetting('insights.mentorPush')) !== 'off';
      const md = mentorPush ? await this.prisma.mentorDay.findUnique({ where: { day: mDay } }) : null;
      if (md?.guidance) {
        await this.send(owner, `🧭 <b>Mentor</b> · on-track ${md.adherenceScore}/100\n\n${this.esc(md.guidance).slice(0, 3500)}`, {
          reply_markup: { inline_keyboard: [[{ text: '🧭 Open Mentor', url: `${PUBLIC_URL}/mentor` }]] },
        });
      }
    }
    const gDay = await this.getSetting('telegram.pushGmailBrief');
    if (gDay) {
      await this.setSetting('telegram.pushGmailBrief', '');
      const gb = await this.prisma.gmailBrief.findUnique({ where: { day: gDay } });
      if (gb?.summary) {
        await this.send(owner, `📧 <b>Email brief</b> · ${gDay}${gb.unread ? ` · ${gb.unread} unread` : ''}\n\n${this.esc(gb.summary).slice(0, 3500)}`, {
          reply_markup: { inline_keyboard: [[{ text: '📧 Open Gmail', url: `${PUBLIC_URL}/google/gmail` }]] },
        });
      }
    }
    const wWeek = await this.getSetting('telegram.pushWeekly');
    if (wWeek) {
      await this.setSetting('telegram.pushWeekly', '');
      const wr = await this.prisma.weeklyReview.findUnique({ where: { weekStart: wWeek } });
      if (wr?.text) {
        const extras = [wr.pattern ? `\n\n🔍 <b>The pattern:</b> ${this.esc(wr.pattern)}` : '', wr.experiment ? `\n🧪 <b>Next week's experiment:</b> ${this.esc(wr.experiment)}` : ''].join('');
        await this.send(owner, `📜 <b>Your weekly review</b> · week of ${wWeek}\n\n${this.esc(wr.text).slice(0, 3200)}${extras}`, {
          reply_markup: { inline_keyboard: [[{ text: '🧭 Open Mentor', url: `${PUBLIC_URL}/mentor` }]] },
        });
      }
    }
  }

  // ---- outbound nudge scheduler ----
  private async firedSet(day: string): Promise<Set<string>> {
    try {
      const raw = JSON.parse((await this.getSetting('telegram.fired')) || '{}');
      if (raw.day === day && Array.isArray(raw.keys)) return new Set(raw.keys);
    } catch {
      /* ignore */
    }
    return new Set();
  }
  private async saveFired(day: string, set: Set<string>) {
    await this.setSetting('telegram.fired', JSON.stringify({ day, keys: [...set] }));
  }

  async listModels() {
    return this.tasks.listModels();
  }

  /** Model that phrases the 4 PM nudge (own picker; defaults to Haiku — it's a tiny job). */
  async nudgeModel(): Promise<LlmConfig> {
    const raw = await this.getSetting('nudge.llm');
    if (raw) {
      try {
        const v = JSON.parse(raw);
        if (v?.provider && v?.model) return v;
      } catch {
        /* ignore */
      }
    }
    return { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' };
  }
  async setNudgeModel(provider: string, model: string) {
    const cfg = this.llm.agentConfig(provider, model);
    await this.setSetting('nudge.llm', JSON.stringify(cfg));
    return cfg;
  }

  /** Monday of the week containing `day` — the rate-limit window for daytime mentor nudges. */
  private weekKeyOf(day: string): string {
    const d = new Date(day + 'T12:00:00Z');
    const dow = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
    return d.toISOString().slice(0, 10);
  }

  /** 4 PM mentor: if a pinned must-do has zero progress, ONE short data-grounded push. Max 3/week — a mentor, not a nag. */
  async daytimeMentor(owner: string, day: string): Promise<void> {
    let rl: { week?: string; count?: number } = {};
    try {
      rl = JSON.parse((await this.getSetting('telegram.mentorNudgeRate')) || '{}');
    } catch {
      /* ignore */
    }
    const week = this.weekKeyOf(day);
    if (rl.week === week && (rl.count || 0) >= 3) return;

    const today = await this.tasks.today();
    const stuck = (today.tasks || []).filter((t: any) => t.status === 'open' && t.pinned && !(t.progress || 0));
    if (!stuck.length) return;

    const recent = await this.prisma.mentorDay.findMany({ orderBy: { day: 'desc' }, take: 7 });
    const avg = recent.length ? Math.round(recent.reduce((s: number, m: any) => s + m.adherenceScore, 0) / recent.length) : null;

    const tmpl = await this.prompts.get('mentor.nudge');
    const prompt =
      `${tmpl}\n\n` +
      `STUCK MUST-DO${stuck.length > 1 ? 'S' : ''}: ${stuck.map((t: any) => `"${t.title}"`).join(', ')}` +
      (avg !== null ? `\nHis average on-track score over the last week is ${avg}/100.` : '');
    const text = (await this.llm.completeWith(await this.nudgeModel(), prompt, 220, 'mentor-nudge'))?.trim();
    if (!text) return;

    await this.setSetting('telegram.mentorNudgeRate', JSON.stringify({ week, count: rl.week === week ? (rl.count || 0) + 1 : 1 }));
    const first = stuck[0];
    await this.send(owner, `🧭 ${this.esc(text)}`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Done', callback_data: `td:${first.id}` }, { text: '30%', callback_data: `tp30:${first.id}` }, { text: '🔕 Today', callback_data: 'akd' }]] },
    });
  }

  /** Nightly backup result from the home server → owner message. Success is silent (3 AM); failure buzzes. */
  async reportBackup(ok: boolean, detail?: string): Promise<{ sent: boolean }> {
    const owner = await this.ownerChatId();
    if (!owner || !(await this.token())) return { sent: false };
    const d = (detail || '').slice(0, 500);
    const text = ok
      ? `✅ <b>Backup synced &amp; verified</b>${d ? ` — ${this.esc(d)}` : ''}`
      : `❌ <b>Backup FAILED</b>${d ? `\n<i>${this.esc(d)}</i>` : ''}\nYour off-server backup did not complete tonight.`;
    await this.send(owner, text, ok ? { disable_notification: true } : {});
    return { sent: true };
  }

  /** Null when off-server backups are healthy; an alert message when the home-server pull is missing/stale (>36h). */
  async backupAlertText(now = Date.now(), statusPath = '/app/data/backup-status.json'): Promise<string | null> {
    let j: any;
    try {
      j = JSON.parse(await fs.readFile(statusPath, 'utf8'));
    } catch {
      return '⚠️ <b>Backup watchdog</b>: I could not read the backup status — the nightly backups may not be running at all.';
    }
    const pull = Date.parse(j?.lastPullAt || '');
    const ageH = Number.isFinite(pull) ? (now - pull) / 3600_000 : Infinity;
    if (ageH <= 36) return null;
    const last = Number.isFinite(pull) ? `${Math.round(ageH)}h ago` : 'never';
    return `⚠️ <b>Backup watchdog</b>: the home server has not pulled a backup recently (last successful pull: ${last}). Check that it is on and connected — your off-server backup is not up to date.`;
  }

  async nudgeTick(): Promise<void> {
    const owner = await this.ownerChatId();
    if (!owner || !(await this.token())) return;
    const tz = await this.tz();
    const day = this.dayKey(tz);
    const hm = this.localHM(tz);

    // Deliver the nightly Story of the Day + Mentor read regardless of rest-day/snooze (not a nag).
    await this.pushPending(owner);

    // Backup watchdog (10 AM, before rest-day/snooze — infrastructure alerts are never a nag)
    if (hm === '10:00' && (await this.getSetting('telegram.backupAlertDay')) !== day) {
      const alert = await this.backupAlertText();
      if (alert) {
        await this.setSetting('telegram.backupAlertDay', day);
        await this.send(owner, alert);
      }
    }

    if ((await this.getSetting('telegram.skipDay')) === day) return; // rest day
    const snooze = Number((await this.getSetting('telegram.snoozeUntil')) || 0);
    if (snooze && Date.now() < snooze) return;

    const fired = await this.firedSet(day);
    const fireOnce = async (key: string, fn: () => Promise<any>) => {
      if (fired.has(key)) return;
      fired.add(key);
      await this.saveFired(day, fired);
      await fn();
    };

    // morning briefing (7 AM): today's focus, each tap-to-complete
    if (hm === '07:00') {
      await fireOnce('briefing', () => this.morningBriefing(owner));
    }
    // morning dump nudges (until dumped, acknowledged, or 9 AM) — now ack-able
    if (['07:30', '08:00', '08:30'].includes(hm)) {
      if (!(await this.prisma.brainDump.findFirst({ where: { day } })) && !(await this.ackedToday('dump', day))) {
        await fireOnce(`dump:${hm}`, () =>
          this.send(owner, "🌅 What's on your mind today? Send /dump and I'll build your task list.", {
            reply_markup: { inline_keyboard: [[{ text: '🧠 Dump now', callback_data: 'acd' }, { text: '👍 Got it', callback_data: 'akd' }]] },
          }),
        );
      }
    }
    // daytime mentor (4 PM): one rare, data-driven push when a pinned must-do hasn't moved
    if (hm === '16:00') {
      await fireOnce('mentor-day', () => this.daytimeMentor(owner, day));
    }
    // evening check-in (9 PM): still-open tasks with Done buttons + a story prompt
    if (hm === '21:00') {
      await fireOnce('checkin', () => this.eveningCheckin(owner));
    }
    // evening story nudges (until told, acknowledged, or 11 PM) — now ack-able
    if (['21:30', '22:00', '22:30'].includes(hm)) {
      if (!(await this.prisma.story.findFirst({ where: { day } })) && !(await this.ackedToday('story', day))) {
        await fireOnce(`story:${hm}`, () =>
          this.send(owner, '🌙 How was your day? Tell me the story.', {
            reply_markup: { inline_keyboard: [[{ text: '🌙 Tell story', callback_data: 'acs' }, { text: '👍 Got it', callback_data: 'aks' }]] },
          }),
        );
      }
    }

    const today = await this.tasks.today();

    // follow-up tasks coming due today — one morning heads-up (09:00)
    if (hm === '09:00') {
      const followUps = today.tasks.filter((t: any) => t.followUp && t.status === 'open');
      if (followUps.length) {
        const lines = followUps.map((t: any) => `• <b>${this.esc(t.title.replace(/^Follow up:\s*/i, ''))}</b>`).join('\n');
        await fireOnce('followups', () => this.send(owner, `🔁 <b>Follow-up${followUps.length > 1 ? 's' : ''} due today</b>\n${lines}`));
      }
    }

    // per-task reminders at their smart times — now actionable (buttons + reply)
    for (const t of today.tasks) {
      if (t.status !== 'open' || !t.reminders?.length) continue;
      if (t.reminders.includes(hm) && !(await this.isTaskSnoozed(t.id))) {
        await fireOnce(`task:${t.id}:${hm}`, async () => {
          const res = await this.send(
            owner,
            `⏰ <b>${this.esc(t.title)}</b>${t.estimateMin ? ` (~${t.estimateMin}m)` : ''}\n<i>reply 👍=done · 30/60=% · text/voice→note</i>`,
            { reply_markup: this.taskKeyboard(t.id) },
          );
          await this.recordTaskMsg(res, t.id);
        });
      }
    }

    // mid-day motivation (progress-driven, Honest-coach)
    if (hm === '12:30' || hm === '15:30') {
      await fireOnce(`motivate:${hm}`, () => this.send(owner, this.motivation(today)));
    }

    // nightly summary push (once the 9:30 summary exists)
    if (hm >= '21:30') {
      const summary = await this.prisma.daySummary.findUnique({ where: { day } });
      if (summary) await fireOnce('summary', () => this.send(owner, `🌙 <b>Your day</b>\n\n${summary.text}`));
    }
  }

  private motivation(today: any): string {
    const done = today.counts.done;
    const total = today.counts.total;
    const pinnedOpen = today.tasks.filter((t: any) => t.pinned && t.status === 'open');
    const carried = today.tasks.filter((t: any) => t.status === 'open' && t.rolloverCount >= 2);
    if (total === 0) return '💭 Nothing planned yet — a 30-second /dump sets up your day.';
    if (done / total >= 0.6) return `🔥 ${done}/${total} done — you're crushing it. Keep the momentum.`;
    if (carried.length) return `👀 "${carried[0].title}" has followed you ${carried[0].rolloverCount} days. 15 minutes now and it's gone for good.`;
    if (pinnedOpen.length) return `⏳ Your must-do "${pinnedOpen[0].title}" is still open. Start it now — the rest can wait.`;
    return `You're at ${done}/${total}. Pick the next one and go — momentum beats motivation.`;
  }

  // ---- voice transcription (provider chosen in Settings; the other is a fallback) ----
  async getVoiceProvider(): Promise<'openai' | 'gemini'> {
    return (await this.getSetting('voice.provider')) === 'gemini' ? 'gemini' : 'openai';
  }
  async setVoiceProvider(p: string): Promise<{ provider: 'openai' | 'gemini' }> {
    const provider = p === 'gemini' ? 'gemini' : 'openai';
    await this.setSetting('voice.provider', provider);
    return { provider };
  }

  private async transcribe(fileId?: string): Promise<string | null> {
    const t = await this.token();
    if (!fileId || !t) return null;
    const f = await this.api('getFile', { file_id: fileId });
    const path = f?.result?.file_path;
    if (!path) return null;
    let buf: Buffer;
    try {
      const r = await fetch(`https://api.telegram.org/file/bot${t}/${path}`);
      if (!r.ok) return null;
      buf = Buffer.from(await r.arrayBuffer());
    } catch {
      return null;
    }
    const name = path.split('/').pop() || 'voice.oga';
    // Use the app-wide voice engine (GPT-4o Transcribe + cleanup) so Telegram matches the in-app mic.
    return (await this.voice.transcribe(buf, name, 'audio/ogg')) || null;
  }

}
