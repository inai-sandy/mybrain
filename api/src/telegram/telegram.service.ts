import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorService } from '../connectors/connector.service';
import { TasksService } from '../tasks/tasks.service';
import { DailyService } from '../daily/daily.service';
import { ChatService } from '../chat/chat.service';

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://mybrain.1site.ai';

const COMMANDS = [
  { command: 'dump', description: "Dump your brain → today's tasks" },
  { command: 'story', description: "Tell tonight's story" },
  { command: 'note', description: 'Jot a quick note' },
  { command: 'add', description: 'Add a single task' },
  { command: 'today', description: "See today's tasks" },
  { command: 'done', description: 'Mark a task done (e.g. /done 2)' },
  { command: 'ask', description: 'Ask your brain / memory anything' },
  { command: 'insights', description: 'Streak, follow-through, time' },
  { command: 'me', description: 'Your personality snapshot' },
  { command: 'activity', description: "Today's summary" },
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
  '/ask — ask your brain anything\n' +
  '/activity — today\'s summary\n' +
  '/insights — streak, follow-through, time\n' +
  '/me — your personality snapshot\n\n' +
  '⚙️ <b>Control</b>\n' +
  '/skip — rest day (no nudges today)\n' +
  '/snooze — quiet nudges for an hour\n\n' +
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
        const fileId = msg.voice?.file_id || msg.audio?.file_id;
        const transcript = await this.transcribe(fileId);
        if (!transcript) {
          await this.send(chatId, '🎙️ Couldn\'t transcribe that — add a valid OpenAI key (Settings → Integrations) or type it instead.');
          return;
        }
        await this.send(chatId, `🎙️ <i>${transcript.slice(0, 200)}</i>`);
        return this.handlePlain(chatId, transcript);
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
      case 'ask':
        if (arg) return this.doAsk(chatId, arg);
        await this.setState({ mode: 'awaiting_ask' });
        return this.send(chatId, '🧠 What do you want to ask your brain?');
      case 'activity':
        return this.doActivity(chatId);
      case 'insights':
      case 'stats':
        return this.doInsights(chatId);
      case 'me':
        return this.doMe(chatId);
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

  /** /ask — query the user's whole brain (stateless), reply with the answer + sources. */
  private async doAsk(chatId: string, question: string) {
    await this.send(chatId, '🧠 Searching your brain…');
    const { answer, sources } = await this.chat.askOnce(question, 'everything');
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

  async nudgeTick(): Promise<void> {
    const owner = await this.ownerChatId();
    if (!owner || !(await this.token())) return;
    const tz = await this.tz();
    const day = this.dayKey(tz);
    const hm = this.localHM(tz);

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

    // morning dump nudges (until dumped or 9 AM)
    if (['07:00', '07:30', '08:00', '08:30'].includes(hm)) {
      if (!(await this.prisma.brainDump.findFirst({ where: { day } }))) {
        await fireOnce(`dump:${hm}`, () => this.send(owner, "🌅 Morning! What's on your mind today? Send /dump and I'll build your task list."));
      }
    }
    // evening story nudges (until told or 11 PM)
    if (['21:00', '21:30', '22:00', '22:30'].includes(hm)) {
      if (!(await this.prisma.story.findFirst({ where: { day } }))) {
        await fireOnce(`story:${hm}`, () => this.send(owner, '🌙 How was your day? Tell me the story — send /story.'));
      }
    }

    const today = await this.tasks.today();

    // per-task reminders at their smart times
    for (const t of today.tasks) {
      if (t.status !== 'open' || !t.reminders?.length) continue;
      if (t.reminders.includes(hm)) {
        await fireOnce(`task:${t.id}:${hm}`, () => this.send(owner, `⏰ Reminder: <b>${t.title}</b>${t.estimateMin ? ` (~${t.estimateMin}m)` : ''}`));
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
    const provider = await this.getVoiceProvider();
    const tryWhisper = async () => {
      const oa = await this.connectors.get<{ apiKey: string }>('openai');
      return oa?.apiKey ? this.whisper(buf, name, oa.apiKey).catch(() => null) : null;
    };
    const tryGemini = () => this.geminiTranscribe(buf, name).catch(() => null);
    // chosen provider first, the other as fallback
    if (provider === 'gemini') return (await tryGemini()) || (await tryWhisper());
    return (await tryWhisper()) || (await tryGemini());
  }

  private async whisper(buf: Buffer, name: string, apiKey: string): Promise<string | null> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)]), name);
    form.append('model', 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form as any });
    if (!r.ok) return null;
    const d: any = await r.json();
    return d?.text?.trim() || null;
  }

  private async geminiTranscribe(buf: Buffer, name: string): Promise<string | null> {
    const or = await this.connectors.get<{ apiKey: string }>('openrouter');
    if (!or?.apiKey) return null;
    const ext = (name.split('.').pop() || 'ogg').toLowerCase();
    const format = ext === 'oga' ? 'ogg' : ext;
    const body = {
      model: 'google/gemini-3-flash-preview',
      max_tokens: 1000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Transcribe this audio verbatim. Output only the transcription, nothing else.' }, { type: 'input_audio', input_audio: { data: buf.toString('base64'), format } }] }],
    };
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${or.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    const d: any = await r.json();
    const text = d?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  }
}
