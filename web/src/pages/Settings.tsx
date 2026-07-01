import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { User, Plug, Palette, Brain, Database, FileText, Send, Bookmark, Globe, Sparkles, Boxes, Check, Cpu, RefreshCw, Wand2, CheckSquare, MessageSquare, RotateCcw, Moon, Compass, Mic, Wallet, Terminal, ShieldCheck, AlertTriangle, FlaskConical, BellRing, ChevronDown, Bot, Loader2, Search, ArrowLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import { useTheme } from '../ui/theme';
import { useToast } from '../ui/Toast';
import { mindApi, fmtWhen, fmtRelative, RUN_KIND, type Activity, type DayRun, type RunStat } from '../mind/client';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { forceUpdate } from '../ui/forceUpdate';

type FieldDef = { key: string; label: string; type?: string };
type Integration = { name: string; label: string; desc: string; icon: LucideIcon; managed?: boolean; testable?: boolean; fields?: FieldDef[] };

const INTEGRATIONS: Integration[] = [
  { name: 'supermemory', label: 'SuperMemory', desc: 'Cloud memory — primary store', icon: Brain, fields: [{ key: 'apiKey', label: 'API key', type: 'password' }, { key: 'project', label: 'Project' }] },
  { name: 'rag', label: 'RAG (on-server)', desc: 'Self-hosted vector memory — second store', icon: Database, managed: true },
  { name: 'notion', label: 'Notion', desc: 'Pull pages into your brain', icon: FileText, fields: [{ key: 'token', label: 'Integration token', type: 'password' }] },
  { name: 'telegram', label: 'Telegram', desc: 'Tasks + daily digests', icon: Send, fields: [{ key: 'botToken', label: 'Bot token', type: 'password' }] },
  { name: 'raindrop', label: 'Raindrop', desc: 'Your bookmarks — pull them in & search by meaning', icon: Bookmark, testable: true, fields: [{ key: 'token', label: 'API token', type: 'password' }] },
  { name: 'tavily', label: 'Tavily', desc: 'Reads web pages so bookmarks can be summarized', icon: Globe, testable: true, fields: [{ key: 'apiKey', label: 'API key', type: 'password' }] },
  { name: 'anthropic', label: 'Anthropic (Claude)', desc: 'Claude models direct', icon: Sparkles, fields: [{ key: 'apiKey', label: 'API key', type: 'password' }] },
  { name: 'openrouter', label: 'OpenRouter', desc: 'One gateway to many models (Claude, GPT, Gemini…)', icon: Boxes, fields: [{ key: 'apiKey', label: 'API key', type: 'password' }] },
  { name: 'openai', label: 'OpenAI', desc: 'Powers voice-to-text (GPT-4o Transcribe) + Whisper', icon: Sparkles, fields: [{ key: 'apiKey', label: 'API key', type: 'password' }] },
  { name: 'openai_admin', label: 'OpenAI Admin (usage)', desc: 'Optional — unlocks your OpenAI spend in the API-usage card. Create an Admin key with the usage-read scope at platform.openai.com → Settings → API keys.', icon: Sparkles, fields: [{ key: 'apiKey', label: 'Admin key', type: 'password' }] },
  { name: 'elevenlabs', label: 'ElevenLabs', desc: 'Optional voice engine — Scribe (most accurate on English)', icon: Mic, fields: [{ key: 'apiKey', label: 'API key', type: 'password' }] },
  { name: 'deepgram', label: 'Deepgram', desc: 'Optional voice engine — Nova-3 (fast)', icon: Mic, fields: [{ key: 'apiKey', label: 'API key', type: 'password' }] },
  { name: 'apify', label: 'Apify (Instagram)', desc: 'Fetches the real caption + a permanent image for Instagram bookmarks (so images stop expiring and descriptions match the reel). Create a free token at apify.com → Settings → Integrations.', icon: Globe, fields: [{ key: 'apiKey', label: 'API token', type: 'password' }] },
];

const MODELS: Record<string, { value: string; label: string }[]> = {
  anthropic: [
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku (fast, cheap)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet (balanced)' },
    { value: 'claude-opus-4-8', label: 'Claude Opus (most capable)' },
  ],
  openrouter: [
    { value: 'anthropic/claude-3.5-haiku', label: 'Claude Haiku' },
    { value: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
    { value: 'google/gemini-flash-1.5', label: 'Gemini Flash' },
    { value: 'meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B' },
  ],
};

type Tab = 'account' | 'integrations' | 'agent' | 'cli' | 'google' | 'models' | 'usage' | 'index' | 'prompts' | 'sync' | 'appearance' | 'activity';

type Cat = { id: Tab; label: string; icon: LucideIcon; desc: string; group: string };
const CATS: Cat[] = [
  { id: 'account', label: 'Account', icon: User, desc: 'Sign-in, privacy, reset', group: 'You & the app' },
  { id: 'appearance', label: 'Appearance', icon: Palette, desc: 'Theme & display', group: 'You & the app' },
  { id: 'usage', label: 'Usage', icon: Wallet, desc: 'Tokens & costs', group: 'You & the app' },
  { id: 'integrations', label: 'Integrations', icon: Plug, desc: 'Connected services & keys', group: 'Connections' },
  { id: 'google', label: 'Google', icon: Globe, desc: 'Workspace services', group: 'Connections' },
  { id: 'cli', label: 'CLI', icon: Terminal, desc: 'Command-line access', group: 'Connections' },
  { id: 'sync', label: 'Sync', icon: RefreshCw, desc: 'Import & reconcile memory', group: 'Connections' },
  { id: 'agent', label: 'Agent Engine', icon: Bot, desc: 'How agents run', group: 'AI brain' },
  { id: 'models', label: 'Models', icon: Cpu, desc: 'Which models do what', group: 'AI brain' },
  { id: 'prompts', label: 'Prompts', icon: MessageSquare, desc: 'Tune the AI prompts', group: 'AI brain' },
  { id: 'index', label: 'Index', icon: Database, desc: "What's in your brain", group: 'AI brain' },
  { id: 'activity', label: 'Activity', icon: FlaskConical, desc: 'The Lab & learning', group: 'AI brain' },
];
const GROUPS = ['You & the app', 'Connections', 'AI brain'];

/** Best-effort live status shown on the tiles. */
function useSettingsStatus() {
  const [s, setS] = useState<Record<string, string>>({});
  const { theme } = useTheme();
  useEffect(() => {
    setS((p) => ({ ...p, appearance: theme === 'dark' ? 'Dark' : 'Light' }));
    /* eslint-disable-next-line */
    fetch('/api/agent/engine').then((r) => r.json()).then((e) => setS((p) => ({ ...p, agent: e?.ok ? 'Online' : 'Offline' }))).catch(() => undefined);
    fetch('/api/connectors').then((r) => r.json()).then((d) => { const list = Array.isArray(d) ? d : d?.connectors || []; const n = list.filter((c: any) => c.connected || c.configured).length; if (list.length) setS((p) => ({ ...p, integrations: `${n} connected` })); }).catch(() => undefined);
    fetch('/api/explore/sources').then((r) => r.json()).then((d) => { const list = Array.isArray(d) ? d : d?.sources || []; const on = list.filter((x: any) => x.enabled).length; if (list.length) setS((p) => ({ ...p, index: `${on} sources on` })); }).catch(() => undefined);
    fetch('/api/google/status').then((r) => r.json()).then((d) => { if (d?.email) setS((p) => ({ ...p, google: d.email })); else if (d?.connected) setS((p) => ({ ...p, google: 'Connected' })); }).catch(() => undefined);
  }, [theme]);
  return s;
}

function renderSection(id: Tab, email?: string): ReactNode {
  switch (id) {
    case 'account': return <AccountSection email={email} />;
    case 'integrations': return <IntegrationsSection />;
    case 'agent': return <AgentEngineSection />;
    case 'cli': return <CliSection />;
    case 'google': return <GoogleServicesSection />;
    case 'models': return <ModelsSection />;
    case 'usage': return <UsageCard />;
    case 'index': return <IndexSection />;
    case 'prompts': return <PromptsSection />;
    case 'sync': return <SyncSection />;
    case 'activity': return <LabActivitySection />;
    case 'appearance': return <AppearanceSection />;
  }
}

// Deep search index — every notable setting, findable by keyword (BEA-714). anchor = id on the detail page.
const SEARCH_INDEX: { label: string; keywords: string; cat: Tab; anchor?: string }[] = [
  { label: 'Dark / light theme', keywords: 'dark light theme appearance colour color mode display', cat: 'appearance', anchor: 'set-theme' },
  { label: 'Account & sign-in', keywords: 'account email sign in login logout password', cat: 'account' },
  { label: 'Privacy', keywords: 'privacy data export', cat: 'account' },
  { label: 'Reset / clear app', keywords: 'reset clear wipe app', cat: 'account' },
  { label: 'Usage, tokens & cost', keywords: 'usage tokens cost spend wallet billing money', cat: 'usage' },
  { label: 'SuperMemory', keywords: 'supermemory memory store connector', cat: 'integrations' },
  { label: 'RAG store', keywords: 'rag vector memory store', cat: 'integrations' },
  { label: 'Notion', keywords: 'notion pages import', cat: 'integrations' },
  { label: 'Telegram', keywords: 'telegram bot notify notification push', cat: 'integrations' },
  { label: 'Raindrop bookmarks', keywords: 'raindrop bookmark', cat: 'integrations' },
  { label: 'Tavily web reader', keywords: 'tavily web read page', cat: 'integrations' },
  { label: 'Deepgram (voice key)', keywords: 'deepgram voice dictation transcribe speech key', cat: 'integrations' },
  { label: 'Apify (Instagram)', keywords: 'apify instagram bookmark enrich', cat: 'integrations' },
  { label: 'Google Workspace', keywords: 'google gmail drive docs sheets calendar workspace', cat: 'google' },
  { label: 'CLI access', keywords: 'cli terminal command line codex', cat: 'cli' },
  { label: 'Import / reconcile memory', keywords: 'sync import reconcile supermemory backfill', cat: 'sync' },
  { label: 'Agent autonomy', keywords: 'autonomy cautious balanced autopilot agent permission approve', cat: 'agent', anchor: 'set-autonomy' },
  { label: 'Agent model', keywords: 'agent model codex gpt engine default', cat: 'agent', anchor: 'set-model' },
  { label: 'Recall brain before a run', keywords: 'recall brain context before search agent', cat: 'agent', anchor: 'set-recall' },
  { label: 'Learn after runs', keywords: 'learn learnings remember after run agent', cat: 'agent', anchor: 'set-learn' },
  { label: 'Which model does what', keywords: 'models story lab meeting voice haiku sonnet gemini per feature', cat: 'models' },
  { label: 'AI prompts', keywords: 'prompt prompts tune instructions wording', cat: 'prompts' },
  { label: 'What gets indexed', keywords: 'index sources vault tasks notes documents memory enable disable', cat: 'index' },
  { label: 'The Lab & activity', keywords: 'lab activity learning mood heatmap findings', cat: 'activity' },
];

function SettingsSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const ql = q.trim().toLowerCase();
  const results = ql ? SEARCH_INDEX.filter((s) => s.label.toLowerCase().includes(ql) || s.keywords.includes(ql)).slice(0, 8) : [];
  const go = (s: { cat: Tab; anchor?: string }) => { setQ(''); nav(`/settings/${s.cat}${s.anchor ? '#' + s.anchor : ''}`); };
  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
        <Search className="h-4 w-4 shrink-0 text-zinc-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) go(results[0]); if (e.key === 'Escape') setQ(''); }} placeholder="Search settings…" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400" />
      </div>
      {ql && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          {results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-zinc-500">No settings match “{q}”.</div>
          ) : results.map((s, i) => {
            const cat = CATS.find((c) => c.id === s.cat)!;
            return (
              <button key={i} onClick={() => go(s)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <cat.icon className="h-4 w-4 shrink-0 text-zinc-400" />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className="shrink-0 text-xs text-zinc-400">{cat.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Scroll to + briefly highlight a settings anchor when the URL has a #hash (BEA-714). */
function useHashHighlight(active: boolean) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!active || !hash) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    const t = setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-emerald-400', 'rounded-xl', 'transition');
      setTimeout(() => el.classList.remove('ring-2', 'ring-emerald-400'), 2200);
    }, 250);
    return () => clearTimeout(t);
  }, [active, hash]);
}

export function Settings({ email }: { email?: string }) {
  const { category } = useParams();
  const nav = useNavigate();
  const status = useSettingsStatus();
  const active = CATS.find((c) => c.id === category);
  useHashHighlight(!!active);

  // ---- detail page for one category ----
  if (active) {
    return (
      <div className="space-y-4">
        <button onClick={() => nav('/settings')} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" />Settings</button>
        <h1 className="flex items-center gap-2 text-2xl font-extrabold"><active.icon className="h-6 w-6 text-emerald-600" />{active.label}</h1>
        {renderSection(active.id, email)}
      </div>
    );
  }

  // ---- tile launcher home ----
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Settings</h1>
        <p className="text-zinc-500">Your account, connected services, and how your brain runs.</p>
      </div>
      <SettingsSearch />
      {GROUPS.map((g) => (
        <section key={g} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{g}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {CATS.filter((c) => c.group === g).map((c) => (
              <button key={c.id} onClick={() => nav(`/settings/${c.id}`)} className="group flex flex-col rounded-2xl border border-zinc-200 bg-white p-4 text-left transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center justify-between">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"><c.icon className="h-5 w-5" /></span>
                  <ChevronRight className="h-4 w-4 text-zinc-300 transition-colors group-hover:text-emerald-500 dark:text-zinc-600" />
                </div>
                <div className="mt-2 font-medium group-hover:text-emerald-600">{c.label}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{status[c.id] || c.desc}</div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function AccountSection({ email }: { email?: string }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: cur, newPassword: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        toast('success', 'Password changed');
        setCur('');
        setNext('');
      } else toast('error', d.message || 'Could not change password');
    } catch {
      toast('error', 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const inp = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500';

  return (
    <div className="space-y-4">
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 max-w-xl">
      <h2 className="font-semibold mb-3">Account</h2>
      <p className="text-sm text-zinc-500 mb-4">
        Signed in as <span className="text-zinc-900 dark:text-zinc-100 font-medium">{email || '—'}</span>
      </p>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Current password</label>
          <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" className={inp} />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">New password (min 8 characters)</label>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" className={inp} />
        </div>
        <button
          type="submit"
          disabled={busy || !cur || next.length < 8}
          className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>

    {/* Privacy promise — the public, plain-English page (BEA-529) */}
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 max-w-xl">
      <h2 className="flex items-center gap-2 font-semibold mb-1"><ShieldCheck size={18} className="text-emerald-600" /> Privacy</h2>
      <p className="text-sm text-zinc-500 mb-3">Your story stays yours — self-hosted, never used to train AI, and your Vault secrets are unreadable to anyone but you. Here's the plain promise.</p>
      <a href="/privacy.html" target="_blank" rel="noopener" className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
        <ShieldCheck size={15} /> Read the privacy promise
      </a>
    </section>

    {/* Update app — moved here from the always-on bottom pill (BEA-441) */}
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 max-w-xl">
      <h2 className="font-semibold mb-1">App</h2>
      <p className="text-sm text-zinc-500 mb-3">On the latest version? Force a clean reload to clear the cache and pull the newest build.</p>
      <button
        onClick={() => forceUpdate()}
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <RefreshCw size={15} /> Update app
      </button>
    </section>
    </div>
  );
}

function EngineField({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id?: string }) {
  return (
    <div id={id} className="flex flex-col gap-1.5 scroll-mt-20 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:pt-1.5">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-zinc-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function toolIcon(name: string) {
  if (name === 'search_brain') return <Brain size={15} />;
  if (name === 'save_document') return <FileText size={15} />;
  return <Sparkles size={15} />;
}

/** A pill toggle whose knob rests flush on both ends (left-0.5 base + 0/5 travel) — shared so every switch matches. */
function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button onClick={() => onChange(!checked)} disabled={disabled} aria-pressed={checked} className={'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ' + (checked ? 'bg-emerald-600' : 'bg-zinc-300 dark:bg-zinc-700')}>
      <span className={'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ' + (checked ? 'translate-x-5' : 'translate-x-0')} />
    </button>
  );
}

function EngineToggle({ label, hint, checked, onChange, id }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; id?: string }) {
  return (
    <div id={id} className="flex flex-col gap-1.5 scroll-mt-20 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-zinc-500">{hint}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

function AgentEngineSection() {
  const toast = useToast();
  const [engine, setEngine] = useState<any>(null);
  const [cfg, setCfg] = useState<any>(null);
  const [models, setModels] = useState<{ value: string; label: string }[]>([]);
  const [collections, setCollections] = useState<any[]>([]);
  const [savedAt, setSavedAt] = useState(0);
  const [restarting, setRestarting] = useState(false);

  const loadEngine = () => fetch('/api/agent/engine').then((r) => r.json()).then(setEngine).catch(() => setEngine({ ok: false }));
  useEffect(() => {
    loadEngine();
    fetch('/api/agent/settings').then((r) => r.json()).then(setCfg).catch(() => setCfg({ model: '', autonomy: 'cautious', askTimeoutMin: 20, recall: true, learn: true, outputCollectionId: null }));
    fetch('/api/agent/models').then((r) => r.json()).then(setModels).catch(() => setModels([]));
    fetch('/api/documents/collections').then((r) => r.json()).then((d) => setCollections(Array.isArray(d) ? d : d?.collections || [])).catch(() => setCollections([]));
  }, []);

  async function save(patch: any) {
    setCfg((c: any) => ({ ...c, ...patch }));
    try { const r = await fetch('/api/agent/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); if (!r.ok) throw new Error(); setSavedAt(Date.now()); } catch { toast('error', 'Could not save'); }
  }
  async function restart() {
    setRestarting(true);
    try { const r = await fetch('/api/agent/engine/restart', { method: 'POST' }); if (!r.ok) throw new Error(); toast('success', 'Engine restarting…'); } catch { toast('error', 'Could not restart the engine'); }
    setTimeout(() => { setRestarting(false); loadEngine(); }, 6000);
  }

  if (!cfg) return <div className="h-48 max-w-2xl animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />;
  const justSaved = savedAt > 0 && Date.now() - savedAt < 2500;

  return (
    <div className="max-w-2xl space-y-4">
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold"><Bot size={18} className="text-emerald-600" /> Engine status</h2>
          <button onClick={loadEngine} className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Refresh</button>
        </div>
        <dl className="space-y-2.5 text-sm">
          <div className="flex items-start justify-between gap-4"><dt className="text-zinc-500">Engine</dt><dd className="text-right">{engine?.ok ? <span className="text-emerald-600 dark:text-emerald-400">● Online · Hermes {engine.version}</span> : <span className="text-amber-600">● Offline{engine?.reason ? ` (${engine.reason})` : ''}</span>}</dd></div>
          <div className="flex items-start justify-between gap-4"><dt className="shrink-0 text-zinc-500">Inference</dt><dd className="text-right">{engine?.connectedToCodex ? <><span>Connected to <b>Codex</b>{engine.model ? ` · ${engine.model}` : ''}</span><div className="text-xs text-zinc-400">ChatGPT subscription · no API key</div></> : <span className="text-zinc-500">{engine?.model || '—'}</span>}</dd></div>
          <div className="flex items-start justify-between gap-4"><dt className="text-zinc-500">Messaging gateway</dt><dd>{engine?.gatewayRunning ? 'On' : <span className="text-zinc-500">Off · no second bot</span>}</dd></div>
          <div className="flex items-start justify-between gap-4"><dt className="text-zinc-500">Access</dt><dd className="text-right text-zinc-600 dark:text-zinc-300">Password-protected · internal only</dd></div>
          <div className="flex items-start justify-between gap-4"><dt className="text-zinc-500">Agents</dt><dd className="text-right">{engine?.counts ? `${engine.counts.agents} saved · ${engine.counts.scheduled} scheduled · ${engine.counts.running} running` : '—'}</dd></div>
          <div className="flex items-start justify-between gap-4"><dt className="shrink-0 text-zinc-500">Watchdog</dt><dd className="text-right">
            {engine?.health?.lastAutoRestartAt
              ? <span className="text-amber-600 dark:text-amber-400">Auto-recovered {new Date(engine.health.lastAutoRestartAt).toLocaleString()}</span>
              : engine?.health?.lastHealthyAt
                ? <><span className="text-emerald-600 dark:text-emerald-400">● Monitoring</span><div className="text-xs text-zinc-400">last healthy {new Date(engine.health.lastHealthyAt).toLocaleTimeString()}</div></>
                : <span className="text-zinc-500">Monitoring</span>}
          </dd></div>
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <button onClick={restart} disabled={restarting} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
            {restarting ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} {restarting ? 'Restarting…' : 'Restart engine'}
          </button>
          <span className="text-xs text-zinc-400">Auto-restarts on crash + reboot — use only if it gets stuck.</span>
        </div>
      </section>

      {engine?.tools && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="mb-1 flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-semibold"><Boxes size={18} className="text-emerald-600" /> Agent tools</h2>
            {engine.tools.connected
              ? <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Connected</span>
              : <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">Not connected</span>}
          </div>
          <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
            Your agent reads and writes your brain mid-task through the <b>{engine.tools.server}</b> tool server, mounted in {engine.tools.registeredWith}.
          </p>
          <ul className="space-y-2.5">
            {engine.tools.items?.map((t: { name: string; desc: string }) => (
              <li key={t.name} className="flex items-start gap-3 rounded-lg border border-zinc-100 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-800/30">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">{toolIcon(t.name)}</span>
                <div className="min-w-0">
                  <div className="font-mono text-sm font-medium text-zinc-800 dark:text-zinc-100">{t.name}</div>
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">{t.desc}</div>
                </div>
              </li>
            ))}
          </ul>
          {engine.tools.connection ? (
            <details className="group mt-3">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 [&::-webkit-details-marker]:hidden dark:hover:text-zinc-300">
                <ChevronDown size={13} className="transition-transform group-open:rotate-180" />
                Connection details
              </summary>
              <dl className="mt-2 space-y-1.5 rounded-lg border border-zinc-100 bg-zinc-50/60 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-800/30">
                {([['Command', 'command'], ['Config', 'config'], ['Endpoint', 'endpoint'], ['Transport', 'transport']] as const).map(([label, key]) => (
                  <div key={key} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                    <dt className="shrink-0 text-zinc-400 sm:w-20">{label}</dt>
                    <dd className="break-all font-mono text-zinc-600 dark:text-zinc-300">{engine.tools.connection[key]}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : (
            <p className="mt-3 text-xs text-zinc-400">Transport: {engine.tools.transport}</p>
          )}
        </section>
      )}

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Settings</h2>
          {justSaved && <span className="flex items-center gap-1 text-xs text-emerald-600"><Check size={14} />Saved</span>}
        </div>
        <div className="space-y-5">
          <EngineField id="set-model" label="Model" hint="Which Codex model runs your agents">
            <select value={cfg.model ?? ''} onChange={(e) => save({ model: e.target.value })} className="w-full max-w-[16rem] rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              {(models.length ? models : [{ value: '', label: 'Engine default' }]).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </EngineField>
          <EngineField id="set-autonomy" label="Autonomy" hint="How often it stops to ask you before acting">
            <select value={cfg.autonomy} onChange={(e) => save({ autonomy: e.target.value })} className="w-full max-w-[16rem] rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              <option value="cautious">Cautious — ask before send/delete/share</option>
              <option value="balanced">Balanced — ask only on the big ones</option>
              <option value="autopilot">Autopilot — never ask, just notify</option>
            </select>
          </EngineField>
          <EngineField label="Ask-me timeout" hint="How long a question waits before it uses the smart default">
            <div className="flex items-center gap-2">
              <input type="number" min={1} max={1440} value={cfg.askTimeoutMin} onChange={(e) => save({ askTimeoutMin: Math.max(1, Number(e.target.value) || 20) })} className="w-24 rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
              <span className="text-sm text-zinc-500">minutes</span>
            </div>
          </EngineField>
          <EngineToggle id="set-recall" label="Recall my brain before each run" hint="Pulls relevant notes from your memory into the task" checked={!!cfg.recall} onChange={(v) => save({ recall: v })} />
          <EngineToggle id="set-learn" label="Propose what it learned after" hint="Suggests durable facts to keep — you confirm" checked={!!cfg.learn} onChange={(v) => save({ learn: v })} />
          <EngineField label="Save results to" hint="Default Documents collection for agent outputs">
            <select value={cfg.outputCollectionId ?? ''} onChange={(e) => save({ outputCollectionId: e.target.value || null })} className="w-full max-w-[16rem] rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              <option value="">Documents (no collection)</option>
              {collections.map((c) => <option key={c.id} value={c.id}>{c.name || c.title}</option>)}
            </select>
          </EngineField>
        </div>
      </section>

      <PublicRagMcpCard />
    </div>
  );
}

/** Public RAG MCP server (BEA-633) — let third-party agents search your brain over HTTPS. */
function PublicRagMcpCard() {
  const [cfg, setCfg] = useState<{ enabled: boolean; token: string; url: string; tools: { name: string; description: string }[] } | null>(null);
  const [show, setShow] = useState(false);
  const [regen, setRegen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { fetch('/api/mcp/config').then((r) => r.json()).then(setCfg).catch(() => setCfg(null)); }, []);
  async function setEnabled(enabled: boolean) {
    setBusy(true);
    try { const r = await fetch('/api/mcp/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }); if (r.ok) { setCfg(await r.json()); toast('success', enabled ? 'RAG MCP server is on' : 'RAG MCP server turned off'); } else toast('error', 'Could not update'); } finally { setBusy(false); }
  }
  async function regenerate() {
    setRegen(false);
    const r = await fetch('/api/mcp/regenerate', { method: 'POST' });
    if (r.ok) { setCfg(await r.json()); toast('success', 'New token — update your connected agents'); } else toast('error', 'Could not regenerate');
  }
  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => toast('success', `${label} copied`)).catch(() => toast('error', 'Could not copy'));
  }
  if (!cfg) return null;
  const masked = show ? cfg.token : cfg.token.slice(0, 6) + '••••••••••••' + cfg.token.slice(-4);
  const inp = 'min-w-0 flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono';
  const snippet = `{
  "mcpServers": {
    "my-brain-rag": {
      "url": "${cfg.url}",
      "headers": { "Authorization": "Bearer ${cfg.token}" }
    }
  }
}`;
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold"><Boxes size={18} className="text-indigo-500" /> RAG server for other agents</h2>
        <Switch checked={cfg.enabled} onChange={setEnabled} disabled={busy} />
      </div>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">Let outside agents (Claude Desktop, ChatGPT, n8n…) <b>search your brain</b> over HTTPS — read-only. Keep the token secret; anyone with it can search your memory. {cfg.enabled ? '' : 'Currently off — turn it on to allow connections.'}</p>

      <label className="mb-1 block text-xs text-zinc-500">Endpoint</label>
      <div className="mb-3 flex gap-2">
        <input readOnly value={cfg.url} className={inp} />
        <button onClick={() => copy(cfg.url, 'URL')} className="shrink-0 rounded-lg border border-zinc-300 px-3 text-sm dark:border-zinc-700">Copy</button>
      </div>
      <label className="mb-1 block text-xs text-zinc-500">Token (Authorization: Bearer)</label>
      <div className="mb-3 flex gap-2">
        <input readOnly value={masked} className={inp} />
        <button onClick={() => setShow((s) => !s)} className="shrink-0 rounded-lg border border-zinc-300 px-3 text-sm dark:border-zinc-700">{show ? 'Hide' : 'Show'}</button>
        <button onClick={() => copy(cfg.token, 'Token')} className="shrink-0 rounded-lg border border-zinc-300 px-3 text-sm dark:border-zinc-700">Copy</button>
      </div>

      <label className="mb-1 block text-xs text-zinc-500">Tools exposed (read-only)</label>
      <ul className="mb-3 space-y-1">
        {cfg.tools.map((t) => (
          <li key={t.name} className="flex items-start gap-2 text-sm"><span className="font-mono text-indigo-600 dark:text-indigo-400">{t.name}</span><span className="text-zinc-500 dark:text-zinc-400">— {t.description}</span></li>
        ))}
      </ul>

      <label className="mb-1 block text-xs text-zinc-500">Connect (paste into the agent's MCP config)</label>
      <pre className="overflow-x-auto whitespace-pre rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-xs font-mono dark:border-zinc-700 dark:bg-zinc-950">{snippet}</pre>
      <div className="mt-4 flex justify-between">
        <button onClick={() => copy(snippet, 'Config')} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">Copy config</button>
        <button onClick={() => setRegen(true)} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-rose-500 hover:border-rose-400 dark:border-zinc-700">Regenerate token</button>
      </div>
      <ConfirmDialog open={regen} title="Regenerate the token?" message="The old token stops working immediately — any agent still using it will be rejected until you update it." confirmLabel="Regenerate" onCancel={() => setRegen(false)} onConfirm={regenerate} />
    </section>
  );
}

function AppearanceSection() {
  const { theme, toggle } = useTheme();
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 max-w-xl">
      <h2 className="font-semibold mb-3">Appearance</h2>
      <div id="set-theme" className="flex items-center justify-between scroll-mt-20">
        <span className="text-sm text-zinc-500">Theme</span>
        <button onClick={toggle} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm capitalize">
          {theme} mode
        </button>
      </div>
    </section>
  );
}

type IndexSrc = { type: string; label: string; total: number; indexed: number; ragIndexed: number; smIndexed: number; lastIndexedAt: string | null; enabled: boolean; mandatory?: boolean; cadence?: 'live' | 'on-update' | 'nightly' };
type SyncHealth = { outbox: Array<{ status: string; count: number }>; unindexed: Array<{ type: string; unindexed: number }> };

const CADENCE_STYLE: Record<string, string> = {
  live: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  nightly: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30',
  'on-update': 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
};
const CADENCE_TITLE: Record<string, string> = {
  live: 'Indexed the moment you save it',
  nightly: 'Indexed at the nightly finalize (11:58 PM) — never a partial daytime version',
  'on-update': 'Re-indexed whenever it regenerates from your story',
};

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (!isFinite(diff) || diff < 0) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

/** Index manager: see what's indexed per section, when, and turn each on/off. (BEA-335) */
function IndexSection() {
  const toast = useToast();
  const [rows, setRows] = useState<IndexSrc[] | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirmOff, setConfirmOff] = useState<IndexSrc | null>(null);
  const [rechunk, setRechunk] = useState<{ running: boolean; total: number; done: number; rechunked: number; skipped: number } | null>(null);
  const [health, setHealth] = useState<SyncHealth | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);

  async function load() {
    try {
      const [srcR, healthR] = await Promise.all([fetch('/api/explore/sources'), fetch('/api/memory/status')]);
      setRows(await srcR.json());
      setHealth(await healthR.json().catch(() => null));
    } catch {
      setRows([]);
    }
  }

  const pendingJobs = health?.outbox.find((o) => o.status === 'pending')?.count ?? 0;
  const failedJobs = health?.outbox.find((o) => o.status === 'failed')?.count ?? 0;

  async function retryFailed() {
    setSyncBusy(true);
    try {
      await fetch('/api/memory/retry', { method: 'POST' });
      toast('success', 'Retrying failed syncs…');
      setTimeout(load, 1500);
    } catch {
      toast('error', 'Could not retry.');
    } finally {
      setSyncBusy(false);
    }
  }
  async function reconcileNow() {
    setSyncBusy(true);
    try {
      await fetch('/api/memory/reconcile', { method: 'POST' });
      toast('success', 'Reconciling RAG ↔ SuperMemory…');
      setTimeout(load, 1500);
    } catch {
      toast('error', 'Could not reconcile.');
    } finally {
      setSyncBusy(false);
    }
  }
  async function pollRechunk() {
    try {
      const r = await fetch('/api/explore/rechunk-status');
      const d = await r.json();
      setRechunk(d);
      if (d.running) setTimeout(pollRechunk, 2000);
      else if (d.total) load();
    } catch {
      /* ignore */
    }
  }
  async function startRechunk() {
    try {
      const r = await fetch('/api/explore/rechunk', { method: 'POST' });
      const d = await r.json();
      if (d.started || d.running) {
        toast('success', 'Optimizing your documents — this runs in the background.');
        setRechunk({ running: true, total: d.total, done: 0, rechunked: 0, skipped: 0 });
        setTimeout(pollRechunk, 1500);
      }
    } catch {
      toast('error', 'Could not start optimization.');
    }
  }
  useEffect(() => {
    load();
    pollRechunk(); // reflect an already-running job
  }, []);

  async function setEnabled(s: IndexSrc, enabled: boolean) {
    setBusy((b) => ({ ...b, [s.type]: true }));
    try {
      const r = await fetch(`/api/explore/sources/${s.type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error();
      toast('success', enabled ? `${s.label} enabled — indexing ${d.reindexed ?? 0} item${d.reindexed === 1 ? '' : 's'}…` : `${s.label} disabled — removed ${d.purged ?? 0} from search`);
      await load();
    } catch {
      toast('error', 'Could not update that section.');
    } finally {
      setBusy((b) => ({ ...b, [s.type]: false }));
    }
  }

  async function reindex(s: IndexSrc) {
    setBusy((b) => ({ ...b, [s.type]: true }));
    try {
      const r = await fetch(`/api/explore/sources/${s.type}/reindex`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error();
      toast('success', `Re-indexing ${d.reindexed ?? 0} ${s.label.toLowerCase()}…`);
      setTimeout(load, 1500);
    } catch {
      toast('error', 'Could not reindex.');
    } finally {
      setBusy((b) => ({ ...b, [s.type]: false }));
    }
  }

  return (
    <section className="space-y-4 max-w-2xl">
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <h2 className="flex items-center gap-2 font-semibold mb-1">
          <Database size={18} className="text-emerald-600" /> Search index
        </h2>
        <p className="text-sm text-zinc-500 mb-4">
          What your <span className="font-medium text-zinc-600 dark:text-zinc-300">Explore</span> brain can search. Everything is mirrored to <b>two</b> stores — <b>RAG</b> (on your server) and <b>SuperMemory</b> (cloud). Turn a section off to remove it from search (your actual data is never deleted — turning it back on re-indexes it).
        </p>

        {/* Sync health: queue state across both stores, with manual retry / reconcile. (BEA-370) */}
        {health && (
          <div className={'mb-4 rounded-lg border p-3 flex items-center justify-between gap-3 ' + (failedJobs > 0 ? 'border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30' : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950')}>
            <div className="text-sm flex items-center gap-2 min-w-0">
              {failedJobs > 0 ? <AlertTriangle size={15} className="text-amber-500 shrink-0" /> : pendingJobs > 0 ? <RefreshCw size={15} className="text-emerald-600 shrink-0 animate-spin" /> : <Check size={15} className="text-emerald-600 shrink-0" />}
              <span className="text-zinc-600 dark:text-zinc-300 truncate">
                {failedJobs > 0 ? `${failedJobs} sync${failedJobs === 1 ? '' : 's'} failed` : pendingJobs > 0 ? `Syncing ${pendingJobs} item${pendingJobs === 1 ? '' : 's'}…` : 'RAG & SuperMemory in sync'}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {failedJobs > 0 && (
                <button onClick={retryFailed} disabled={syncBusy} className="rounded-lg border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 px-2.5 py-1 text-xs hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50">Retry failed</button>
              )}
              <button onClick={reconcileNow} disabled={syncBusy} title="Re-check both stores and fill any gaps" className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50">Reconcile now</button>
            </div>
          </div>
        )}

        {rows === null && <div className="text-sm text-zinc-400">Loading…</div>}
        {rows?.length === 0 && <div className="text-sm text-zinc-400">No sections yet.</div>}

        <div className="space-y-2.5">
          {rows?.map((s) => {
            const pct = s.total ? Math.round((s.indexed / s.total) * 100) : 0;
            return (
              <div key={s.type} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium flex items-center gap-2">
                      {s.label}
                      {s.cadence && (
                        <span title={CADENCE_TITLE[s.cadence]} className={'text-[10px] px-1.5 py-0.5 rounded-full border ' + (CADENCE_STYLE[s.cadence] || CADENCE_STYLE.live)}>
                          {s.cadence}
                        </span>
                      )}
                      {!s.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border border-zinc-200 dark:border-zinc-700">off</span>}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {s.enabled ? (
                        <>
                          <span className="tabular-nums">{s.indexed}</span> of <span className="tabular-nums">{s.total}</span> indexed · last {relTime(s.lastIndexedAt)}
                        </>
                      ) : (
                        <>
                          <span className="tabular-nums">{s.total}</span> item{s.total === 1 ? '' : 's'} · not in search
                        </>
                      )}
                    </div>
                    {s.enabled && s.total > 0 && (
                      <div className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
                        <span className="text-zinc-500">RAG <span className="tabular-nums text-zinc-600 dark:text-zinc-300">{s.ragIndexed}</span> · SuperMemory <span className="tabular-nums text-zinc-600 dark:text-zinc-300">{s.smIndexed}</span></span>
                        {s.ragIndexed === s.smIndexed ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> in sync</span>
                        ) : pendingJobs > 0 ? (
                          // Counts differ but the queue is still draining — normal mid-sync, not a problem.
                          <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400"><RefreshCw size={10} className="animate-spin" /> syncing…</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> out of sync</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {s.enabled && s.total > 0 && (
                      <button
                        onClick={() => reindex(s)}
                        disabled={busy[s.type]}
                        title="Re-index now"
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50 transition"
                      >
                        <RefreshCw size={15} className={busy[s.type] ? 'animate-spin' : ''} />
                      </button>
                    )}
                    {s.mandatory ? (
                      <span title="Always indexed — can't be turned off" className="text-[10px] px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 font-medium">
                        Always on
                      </span>
                    ) : (
                      <button
                        onClick={() => (s.enabled ? setConfirmOff(s) : setEnabled(s, true))}
                        disabled={busy[s.type]}
                        aria-label={s.enabled ? 'Disable' : 'Enable'}
                        className={'relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ' + (s.enabled ? 'bg-emerald-600' : 'bg-zinc-300 dark:bg-zinc-700')}
                      >
                        <span className={'inline-block h-4 w-4 transform rounded-full bg-white transition-transform ' + (s.enabled ? 'translate-x-6' : 'translate-x-1')} />
                      </button>
                    )}
                  </div>
                </div>
                {s.enabled && s.total > 0 && (
                  <div className="mt-2 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                    <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <h2 className="flex items-center gap-2 font-semibold mb-1">
          <RefreshCw size={18} className="text-emerald-600" /> Optimize existing documents
        </h2>
        <p className="text-sm text-zinc-500 mb-3">
          Older documents were stored as one big blob (long ones could lose their tail). This re-splits them into clean, fully-searchable chunks — pulling the complete text from your cloud memory. Safe to run anytime.
        </p>
        {rechunk?.running ? (
          <div>
            <div className="text-sm text-zinc-600 dark:text-zinc-300 mb-1.5">
              Optimizing… <span className="tabular-nums">{rechunk.done}</span> / <span className="tabular-nums">{rechunk.total}</span>
            </div>
            <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${rechunk.total ? Math.round((rechunk.done / rechunk.total) * 100) : 0}%` }} />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button onClick={startRechunk} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white px-3.5 py-2 text-sm font-semibold transition">
              <RefreshCw size={15} /> Optimize now
            </button>
            {rechunk && rechunk.total > 0 && (
              <span className="text-xs text-zinc-400">Last run: {rechunk.rechunked} re-chunked{rechunk.skipped ? `, ${rechunk.skipped} skipped` : ''}</span>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmOff}
        title={`Turn off ${confirmOff?.label}?`}
        message={`${confirmOff?.label} will be removed from Explore search. Your actual ${confirmOff?.label.toLowerCase()} are NOT deleted — turning this back on re-indexes them.`}
        confirmLabel="Turn off"
        onCancel={() => setConfirmOff(null)}
        onConfirm={() => {
          const s = confirmOff!;
          setConfirmOff(null);
          setEnabled(s, false);
        }}
      />
    </section>
  );
}

function AiModelCard() {
  const [cfg, setCfg] = useState<any>(null);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [custom, setCustom] = useState(false);
  const toast = useToast();

  useEffect(() => {
    fetch('/api/llm-config')
      .then((r) => r.json())
      .then((d) => {
        setCfg(d);
        if (d.provider) setProvider(d.provider);
        if (d.model) {
          const known = (MODELS[d.provider] || []).some((m) => m.value === d.model);
          setCustom(!known);
          setModel(d.model);
        }
      })
      .catch(() => setCfg({ providers: {} }));
  }, []);

  if (!cfg) return null;
  const avail = cfg.providers || {};
  const models = MODELS[provider] || [];

  async function save() {
    const r = await fetch('/api/llm-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    if (r.ok) toast('success', 'AI model saved');
    else toast('error', (await r.json().catch(() => ({}))).message || 'Could not save');
  }

  const sel = 'w-full mt-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm';

  return (
    <AccordionCard title="Default AI model" icon={Sparkles}>
      <p className="text-sm text-zinc-500 mb-4">Used for tagging &amp; summaries (and the chat assistant later). Connect the provider's key below first.</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-sm text-zinc-600 dark:text-zinc-400">
          Provider
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel('');
              setCustom(false);
            }}
            className={sel}
          >
            <option value="anthropic" disabled={!avail.anthropic}>Anthropic{avail.anthropic ? '' : ' (connect key)'}</option>
            <option value="openrouter" disabled={!avail.openrouter}>OpenRouter{avail.openrouter ? '' : ' (connect key)'}</option>
          </select>
        </label>
        <label className="text-sm text-zinc-600 dark:text-zinc-400">
          Model
          <select
            value={custom ? '__custom__' : model}
            onChange={(e) => {
              if (e.target.value === '__custom__') {
                setCustom(true);
                setModel('');
              } else {
                setCustom(false);
                setModel(e.target.value);
              }
            }}
            className={sel}
          >
            <option value="">Choose…</option>
            {models.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
            <option value="__custom__">Custom…</option>
          </select>
        </label>
      </div>
      {custom && (
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="model id (e.g. openai/gpt-4o)"
          className="mt-3 w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
        />
      )}
      <div className="mt-4 text-right">
        <button onClick={save} disabled={!model} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
          Save
        </button>
      </div>
    </AccordionCard>
  );
}

type UsageData = {
  openrouter: { today: number; week: number; month: number; total: number; credits: { total: number; used: number; remaining: number } | null } | null;
  openai: { available: boolean; today?: number; week?: number; month?: number; reason?: string };
};
function fmtUsd(n?: number): string {
  if (n === undefined || n === null) return '—';
  if (n > 0 && n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

const USAGE_BUCKETS: { key: string; label: string; icon: LucideIcon; match: RegExp }[] = [
  { key: 'agents', label: 'Agents & flows', icon: Bot, match: /^(agent|flow|eval)/ },
  { key: 'daily', label: 'Daily & Story', icon: Sparkles, match: /(story|day-summary|month-story|year-story|suggested-task|task-dump|personality)/ },
  { key: 'lab', label: 'The Lab', icon: FlaskConical, match: /(mind-model|mentor|lab)/ },
  { key: 'voice', label: 'Voice & Meetings', icon: Mic, match: /(voice|meeting|transcribe)/ },
  { key: 'research', label: 'Research & Email', icon: Bookmark, match: /(explore|bookmark|research|gmail|capture)/ },
  { key: 'chat', label: 'Chat', icon: MessageSquare, match: /^chat/ },
];
const usageBucket = (feature: string) => USAGE_BUCKETS.find((b) => b.match.test(feature));

function UsageCard() {
  const [u, setU] = useState<UsageData | null>(null);
  const [feat, setFeat] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch('/api/usage').then((r) => r.json()).then(setU).catch(() => setFailed(true));
    fetch('/api/usage/features?days=30').then((r) => r.json()).then(setFeat).catch(() => undefined);
  }, []);
  const or = u?.openrouter;
  const pct = or?.credits && or.credits.total > 0 ? Math.min(100, Math.round((or.credits.used / or.credits.total) * 100)) : null;
  const total = feat?.totalCost ?? 0;
  const tiles = (() => {
    if (!feat?.features) return null;
    const m: Record<string, { label: string; icon: LucideIcon; cost: number; requests: number }> = {};
    for (const f of feat.features) {
      if (f.included) continue;
      const b = usageBucket(f.feature);
      const key = b?.key || 'other';
      m[key] = m[key] || { label: b?.label || 'Other', icon: b?.icon || Boxes, cost: 0, requests: 0 };
      m[key].cost += f.cost; m[key].requests += f.requests;
    }
    return Object.values(m).sort((a, b) => b.cost - a.cost);
  })();

  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1"><Wallet size={18} className="text-emerald-600" /> API usage</h2>
      <p className="text-sm text-zinc-500 mb-4">What your AI actually costs — computed from real token usage (last 30 days).</p>
      {failed && !feat ? (
        <p className="text-sm text-zinc-400">Couldn’t load usage right now.</p>
      ) : !feat ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : (
        <div className="space-y-5">
          {/* Real total + included */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
              <div className="text-xs text-zinc-500">Real spend · last 30 days</div>
              <div className="mt-1 text-3xl font-extrabold tabular-nums">{fmtUsd(total)}</div>
              <div className="text-xs text-zinc-400">{(feat.totalRequests || 0).toLocaleString()} requests</div>
            </div>
            <div className="rounded-2xl border border-violet-200 bg-violet-50/50 p-4 dark:border-violet-500/30 dark:bg-violet-500/10">
              <div className="text-xs text-violet-700 dark:text-violet-300">Included in your ChatGPT plan</div>
              <div className="mt-1 text-3xl font-extrabold tabular-nums text-violet-700 dark:text-violet-300">~{fmtUsd(feat.includedEstimate || 0)}</div>
              <div className="text-xs text-violet-700/70 dark:text-violet-300/70">{(feat.includedRequests || 0).toLocaleString()} agent runs · not billed</div>
            </div>
          </div>

          {/* By-feature tiles */}
          {tiles && tiles.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Where it goes</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {tiles.map((t) => {
                  const share = total > 0 ? Math.round((t.cost / total) * 100) : 0;
                  return (
                    <div key={t.label} className="rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="flex items-center gap-1.5 text-sm font-medium"><t.icon size={15} className="text-emerald-600" />{t.label}</div>
                      <div className="mt-1.5 text-lg font-extrabold tabular-nums">{fmtUsd(t.cost)}</div>
                      <div className="text-[11px] text-zinc-400">{t.requests} req · {share}%</div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"><div className="h-full bg-emerald-500" style={{ width: `${share}%` }} /></div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* OpenRouter credits */}
          {or?.credits && (
            <div>
              <div className="flex justify-between text-xs text-zinc-500 mb-1">
                <span>OpenRouter account credits</span>
                <span className="tabular-nums">{fmtUsd(or.credits.remaining)} left of {fmtUsd(or.credits.total)}</span>
              </div>
              <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                <div className={'h-full ' + ((pct ?? 0) > 90 ? 'bg-rose-500' : (pct ?? 0) > 75 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct ?? 0}%` }} />
              </div>
            </div>
          )}

          <RequestLog />
        </div>
      )}
    </section>
  );
}

const FEATURE_NAMES: Record<string, string> = {
  chat: 'Chat', 'chat-router': 'Chat routing', 'task-dump': 'Brain dump → tasks', 'story-of-day': 'Story of the Day',
  'day-summary': 'Day summary', 'suggested-tasks': 'Suggested tasks', 'mentor-guidance': 'Mentor guidance',
  'mentor-focus': 'Mentor focus areas', personality: 'Personality', 'voice-cleanup': 'Voice cleanup',
  'voice-transcribe': 'Voice transcription', 'capture-enrich': 'Capture enrichment', 'idea-organize': 'Ideas organizer',
  'skill-describe': 'Skill description', 'meeting-transcribe': 'Meeting transcription', 'meeting-summary': 'Meeting summary',
  'tasks-dedupe': 'Remove duplicate tasks', 'weekly-review': 'Weekly review', 'people-extract': 'People extraction', other: 'Other',
};
const fName = (f: string) => FEATURE_NAMES[f] || f;

type FeatRow = { feature: string; cost: number; requests: number };
type ReqRow = { id: string; at: string; feature: string; model: string; cost: number | null };

function todayStr() { return new Date().toISOString().slice(0, 10); }
function daysAgoStr(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }

function RequestLog() {
  const [from, setFrom] = useState(daysAgoStr(30));
  const [to, setTo] = useState(todayStr());
  const [feats, setFeats] = useState<{ features: FeatRow[]; totalCost: number; totalRequests: number } | null>(null);
  const [reqs, setReqs] = useState<ReqRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const PAGE = 25;
  const range = `from=${from}&to=${to}`;

  useEffect(() => {
    fetch(`/api/usage/features?${range}`).then((r) => r.json()).then(setFeats).catch(() => undefined);
    setPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);
  useEffect(() => {
    fetch(`/api/usage/requests?limit=${PAGE}&offset=${page * PAGE}&${range}${filter ? `&feature=${filter}` : ''}`)
      .then((r) => r.json())
      .then((d) => { setReqs(d.requests || []); setTotal(d.total || 0); })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, filter, page]);

  const maxReq = Math.max(1, ...(feats?.features.map((f) => f.requests) || [0]));
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const dateInput = 'rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 text-sm';

  return (
    <>
      {/* Date range (calendar) */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-400">From</span>
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={dateInput} />
        <span className="text-xs text-zinc-400">to</span>
        <input type="date" value={to} min={from} max={todayStr()} onChange={(e) => setTo(e.target.value)} className={dateInput} />
      </div>

      {/* By feature (ranked by requests so transcription/Deepgram shows even with no $ figure) */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-2">By feature{feats ? ` · ${fmtUsd(feats.totalCost)} · ${feats.totalRequests} requests` : ''}</div>
        {feats && feats.features.length ? (
          <div className="space-y-1.5">
            {feats.features.map((f) => (
              <div key={f.feature} className="flex items-center gap-2 text-sm whitespace-nowrap">
                <span className="w-44 shrink-0 truncate text-zinc-600 dark:text-zinc-300">{fName(f.feature)}</span>
                <div className="flex-1 min-w-[36px] h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: `${Math.max(3, Math.round((f.requests / maxReq) * 100))}%` }} />
                </div>
                <span className="w-16 text-right tabular-nums text-zinc-500 text-xs shrink-0">{fmtUsd(f.cost)}</span>
                <span className="w-12 text-right tabular-nums text-zinc-400 text-[11px] shrink-0">{f.requests}×</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-400">No requests in this range.</p>
        )}
      </div>

      {/* Request log — a real table; nothing wraps, scrolls sideways on small screens */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Requests{total ? ` · ${total}` : ''}</div>
          <select aria-label="Filter by feature" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} className="rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs">
            <option value="">All features</option>
            {(feats?.features || []).map((f) => <option key={f.feature} value={f.feature}>{fName(f.feature)}</option>)}
          </select>
        </div>
        {reqs.length ? (
          <div className="overflow-x-auto rounded-lg border border-zinc-100 dark:border-zinc-800">
            <table className="w-full text-xs">
              <thead className="text-zinc-400 border-b border-zinc-100 dark:border-zinc-800">
                <tr className="text-left">
                  <th className="px-2.5 py-1.5 font-medium whitespace-nowrap">When</th>
                  <th className="px-2.5 py-1.5 font-medium whitespace-nowrap">Feature</th>
                  <th className="px-2.5 py-1.5 font-medium whitespace-nowrap">Model</th>
                  <th className="px-2.5 py-1.5 font-medium text-right whitespace-nowrap">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {reqs.map((r) => (
                  <tr key={r.id} className="whitespace-nowrap">
                    <td className="px-2.5 py-1.5 text-zinc-400 tabular-nums">{new Date(r.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="px-2.5 py-1.5 text-zinc-600 dark:text-zinc-300">{fName(r.feature)}</td>
                    <td className="px-2.5 py-1.5 text-zinc-400 max-w-[200px] truncate">{r.model.replace(/^.*\//, '')}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{r.cost === null ? '—' : fmtUsd(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">No requests in this range{filter ? ' for this feature' : ''}.</p>
        )}
        {total > PAGE && (
          <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 disabled:opacity-40">← Prev</button>
            <span>Page {page + 1} of {pages}</span>
            <button onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 disabled:opacity-40">Next →</button>
          </div>
        )}
      </div>
    </>
  );
}

/** Collapsible card — header (icon + title + optional badge + chevron) with the body hidden until tapped. (BEA-531) */
function AccordionCard({ title, icon: Icon, badge, defaultOpen, children }: { title: string; icon?: LucideIcon; badge?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-center justify-between gap-3 p-5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
        <span className="flex items-center gap-2 font-semibold min-w-0">
          {Icon && <Icon size={18} className="text-emerald-600 shrink-0" />}
          <span className="truncate">{title}</span>
          {badge}
        </span>
        <ChevronDown size={18} className={'shrink-0 text-zinc-400 transition-transform ' + (open ? 'rotate-180' : '')} />
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </section>
  );
}

function ModelsSection() {
  return (
    <div className="space-y-4">
      <AiModelCard />
      <ChatModelCard />
      <EngineModelCard title="Explore answer model" icon={Sparkles} base="/api/explore/model"
        desc="Writes your Explore answers from your indexed brain. Sonnet (default) is the most capable; switch to Haiku to cut the cost per question by ~3–4× (each ask is mostly the model reading your retrieved notes)." />
      <EngineModelCard title="Reminder Clean up model" icon={Sparkles} base="/api/reminders/format-model"
        desc="Rewrites your rough words into a proper WhatsApp reminder (the ✨ Clean up button in a reminder). This is a quick, live action, so it uses a dependable API model — Sonnet (default) is reliable; Haiku is cheaper and still good. (Free Codex/Gemini engines aren't offered here because they're too slow/flaky for a live tap.)" />
      <BookmarksModelCard />
      <TasksModelCard />
      <MeetingsEngineCard />
      <EngineModelCard title="Meeting summary model" icon={Mic} base="/api/meetings/model"
        desc="The AI that writes each meeting's title, summary, key takeaways, decisions and action items." />
      <EngineModelCard title="Story of the Day model" icon={Moon} base="/api/daily/story-model" agents
        desc="Writes your nightly Story of the Day (11:58 PM) from your story + tasks + activity. Pick a Claude/GPT API model, or run it FREE on your Codex/Gemini subscription (slower, but it's a nightly job)." />
      <EngineModelCard title="Mentor model" icon={Compass} base="/api/mentor/model" agents
        desc="Powers Mentor Mode — reads your stories, sets your focus areas, and writes your daily guidance. Pick a strong Claude API model, or run it FREE on your Codex/Gemini subscription." />
      <EngineModelCard title="Weekly review model" icon={Compass} base="/api/mentor/weekly-model" agents
        desc="Writes the Sunday-night weekly review (wins, drift, the pattern, the experiment). Until you pick one it follows the Mentor model. Can run FREE on your Codex/Gemini subscription." />
      <EngineModelCard title="Book model (chapters & year)" icon={Moon} base="/api/daily/book-model" agents
        desc="Writes the monthly chapters and the Story of the Year — the best writing in the app. Until you pick one it follows the Story of the Day model. Can run FREE on your Codex/Gemini subscription." />
      <EngineModelCard title="4 PM nudge model" icon={Compass} base="/api/telegram/nudge-model" agents
        desc="Phrases the short afternoon Telegram nudge when a pinned must-do hasn't moved. A tiny job — Haiku (the default) is ideal, or run it FREE on your Codex/Gemini subscription." />
      <EngineModelCard title="People extraction model" icon={Compass} base="/api/daily/people-model" agents
        desc="Pulls people's names from your nightly story and tasks for People memory. A tiny job — Haiku (the default) is ideal, or run it FREE on your Codex/Gemini subscription." />
      <EngineModelCard title="Day summary model" icon={FileText} base="/api/daily/summary-model" agents
        desc="Writes the short end-of-day summary (tasks done, what's pending, the gist). Until you pick one it follows the Tasks engine. Can run FREE on your Codex/Gemini subscription." />
      <EngineModelCard title="Email Daily Brief model" icon={Send} base="/api/google/gmail-brief-model" agents
        desc="Writes your nightly Gmail Daily Brief — groups the day's important emails into topics. Sonnet (default) is strong, or run it FREE on your Codex/Gemini subscription (it's a nightly job)." />
      <EngineModelCard title="The Lab — how it reasons about you" icon={FlaskConical} base="/api/mind/model" agents
        desc="The mini mental model that learns your patterns from your tasks + stories each night. Sonnet (default) does the deep reasoning, or run it FREE on your Codex/Gemini subscription with Sonnet auto-fallback." />
      <EngineModelCard title="Documents summary model" icon={FileText} base="/api/documents/model" agents
        desc="Writes the title, description and tags for documents you upload or create. A tiny job — Haiku (the default) is ideal, or run it FREE on your Codex/Gemini subscription." />
      <VoiceModelCard />
    </div>
  );
}

/** Reusable model picker for an engine that exposes GET/PUT `${base}` + GET `${base}s`. */
function EngineModelCard({ title, desc, icon: Icon, base, agents }: { title: string; desc: string; icon: LucideIcon; base: string; agents?: boolean }) {
  const FALLBACK = [
    { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (best, recommended)' },
    { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6 (deepest)' },
    { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5 (fast)' },
    { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
    { id: 'openai/gpt-4o', name: 'GPT-4o' },
  ];
  // Subscription agents (no per-use API cost) — offered where latency is OK. (BEA-360/361)
  const AGENT_OPTS = [
    { id: 'gemini::Gemini 3.5 Flash', name: '✦ Gemini 3.5 Flash — your Google plan (free · ~13s)' },
    { id: 'gemini::Gemini 3.1 Pro', name: '✦ Gemini 3.1 Pro — your Google plan (free · deeper)' },
    { id: 'codex', name: '⚡ Codex — your ChatGPT plan (free · ~25s)' },
  ];
  const [opts, setOpts] = useState<{ id: string; name: string }[]>([]);
  const [model, setModel] = useState('');
  const [custom, setCustom] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();
  useEffect(() => {
    Promise.all([
      fetch(base).then((r) => r.json()).catch(() => ({})),
      fetch(base + 's').then((r) => r.json()).catch(() => ({ models: [] })),
    ])
      .then(([cfg, list]) => {
        const models = (list.models || []) as { id: string; name: string }[];
        const finalOpts = [...(agents ? AGENT_OPTS : []), ...(models.length ? models : FALLBACK)];
        setOpts(finalOpts);
        // Derive the picker id from the saved engine: agents store provider gemini/codex with a plain model name.
        const m = cfg.provider === 'gemini' ? `gemini::${cfg.model}` : cfg.provider === 'codex' ? 'codex' : (cfg.model || '');
        setModel(m);
        setCustom(!!m && !finalOpts.some((o) => o.id === m));
      })
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  if (!loaded) return null;
  async function save() {
    const r = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    if (r.ok) toast('success', 'Model saved');
    else toast('error', (await r.json().catch(() => ({}))).message || 'Could not save');
  }
  const sel = 'w-full mt-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm';
  return (
    <AccordionCard title={title} icon={Icon}>
      <p className="text-sm text-zinc-500 mb-4">{desc}</p>
      <label className="text-sm text-zinc-600 dark:text-zinc-400 block">
        Model
        <select value={custom ? '__custom__' : model} onChange={(e) => { if (e.target.value === '__custom__') { setCustom(true); setModel(''); } else { setCustom(false); setModel(e.target.value); } }} className={sel}>
          <option value="">Choose…</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          <option value="__custom__">Custom…</option>
        </select>
      </label>
      {custom && <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="openrouter model id (e.g. anthropic/claude-sonnet-4.6)" className="mt-3 w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />}
      {agents && <p className="mt-3 flex items-start gap-1.5 text-xs text-zinc-500 dark:text-zinc-400"><ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-600" />The free engines (✦/⚡) cost nothing but run on your server. If one is ever busy or offline, this feature automatically falls back to <b>Claude Sonnet</b> on the API — so it never silently fails.</p>}
      <div className="mt-4 text-right">
        <button onClick={save} disabled={!model} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">Save</button>
      </div>
    </AccordionCard>
  );
}

function MeetingsEngineCard() {
  const [engines, setEngines] = useState<{ id: string; name: string; configured: boolean }[]>([]);
  const [engine, setEngine] = useState('deepgram');
  const [autoDelete, setAutoDelete] = useState(false);
  const [dgModels, setDgModels] = useState<{ id: string; name: string }[]>([]);
  const [dgModel, setDgModel] = useState('nova-3');
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();
  useEffect(() => {
    Promise.all([
      fetch('/api/meetings/engines').then((r) => r.json()).catch(() => ({})),
      fetch('/api/meetings/auto-delete-audio').then((r) => r.json()).catch(() => ({})),
      fetch('/api/voice/deepgram-models').then((r) => r.json()).catch(() => ({})),
      fetch('/api/voice/deepgram-model').then((r) => r.json()).catch(() => ({})),
    ])
      .then(([eng, ad, dgm, dgc]) => { setEngines(eng.engines || []); setEngine(eng.default || 'deepgram'); setAutoDelete(!!ad.enabled); setDgModels(dgm.models || []); setDgModel(dgc.model || 'nova-3'); })
      .finally(() => setLoaded(true));
  }, []);
  if (!loaded) return null;
  async function save() {
    const r = await fetch('/api/meetings/engine', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine }) });
    if (r.ok) toast('success', 'Transcription engine saved');
    else toast('error', 'Could not save');
  }
  async function toggleAutoDelete(on: boolean) {
    setAutoDelete(on);
    await fetch('/api/meetings/auto-delete-audio', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) }).catch(() => undefined);
  }
  async function pickDgModel(m: string) {
    setDgModel(m);
    await fetch('/api/voice/deepgram-model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: m }) }).catch(() => undefined);
    toast('success', 'Deepgram model saved');
  }
  const sel = 'w-full mt-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm';
  return (
    <AccordionCard title="Meeting transcription engine" icon={Mic}>
      <p className="text-sm text-zinc-500 mb-4">Which engine turns meeting recordings into text. Deepgram is the cheapest for long meetings; others need their API key in Integrations. (You can also pick per-meeting when you hit Transcribe.)</p>
      <label className="text-sm text-zinc-600 dark:text-zinc-400 block">
        Engine
        <select value={engine} onChange={(e) => setEngine(e.target.value)} className={sel}>
          {engines.map((e) => <option key={e.id} value={e.id} disabled={!e.configured}>{e.name}{e.configured ? '' : ' — needs API key'}</option>)}
        </select>
      </label>
      <label className="mt-3 text-sm text-zinc-600 dark:text-zinc-400 block">
        Deepgram model
        {dgModels.length ? (
          <select value={dgModel} onChange={(e) => pickDgModel(e.target.value)} className={sel}>
            {!dgModels.some((m) => m.id === dgModel) && <option value={dgModel}>{dgModel}</option>}
            {dgModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        ) : (
          <p className="text-xs text-zinc-400 mt-1">Connect your Deepgram key in Integrations to choose from all models (currently <b>{dgModel}</b>).</p>
        )}
      </label>
      <label className="mt-4 flex items-start gap-2.5 text-sm cursor-pointer">
        <input type="checkbox" checked={autoDelete} onChange={(e) => toggleAutoDelete(e.target.checked)} className="mt-0.5 h-4 w-4 accent-emerald-600" />
        <span><span className="font-medium">Delete the recording after transcribing</span><br /><span className="text-xs text-zinc-500">Frees disk on long meetings — the transcript and summary are kept. You can also delete a recording manually on its page.</span></span>
      </label>
      <div className="mt-4 text-right">
        <button onClick={save} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm">Save</button>
      </div>
    </AccordionCard>
  );
}

function ChatModelCard() {
  const FALLBACK = [
    { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5 (fast, recommended)' },
    { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash (fastest)' },
    { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini (fast)' },
    { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (best, slower)' },
  ];
  const [opts, setOpts] = useState<{ id: string; name: string }[]>([]);
  const [model, setModel] = useState('');
  const [custom, setCustom] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();
  useEffect(() => {
    Promise.all([
      fetch('/api/chat/model').then((r) => r.json()).catch(() => ({})),
      fetch('/api/chat/models').then((r) => r.json()).catch(() => ({ models: [] })),
    ])
      .then(([cfg, list]) => {
        const models = ((list.models || []) as { id: string; name: string }[]);
        const finalOpts = models.length ? models : FALLBACK;
        setOpts(finalOpts);
        const m = cfg.model || '';
        setModel(m);
        setCustom(!!m && !finalOpts.some((o) => o.id === m));
      })
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!loaded) return null;
  async function save() {
    const r = await fetch('/api/chat/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    if (r.ok) toast('success', 'Chat model saved');
    else toast('error', (await r.json().catch(() => ({}))).message || 'Could not save');
  }
  const sel = 'w-full mt-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm';
  return (
    <AccordionCard title="Chat AI model" icon={MessageSquare}>
      <p className="text-sm text-zinc-500 mb-4">Runs “talk to my brain”. Pick a <b>fast</b> model — a slow one makes replies take ages. Defaults to Claude Haiku. Uses your OpenRouter key.</p>
      <label className="text-sm text-zinc-600 dark:text-zinc-400 block">
        Model
        <select value={custom ? '__custom__' : model} onChange={(e) => { if (e.target.value === '__custom__') { setCustom(true); setModel(''); } else { setCustom(false); setModel(e.target.value); } }} className={sel}>
          <option value="">Choose…</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          <option value="__custom__">Custom…</option>
        </select>
      </label>
      {custom && <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="openrouter model id (e.g. anthropic/claude-haiku-4.5)" className="mt-3 w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />}
      <div className="mt-4 text-right">
        <button onClick={save} disabled={!model} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">Save</button>
      </div>
    </AccordionCard>
  );
}

type VoiceCfg = { engine: string; engines: { id: string; name: string; configured: boolean }[]; cleanup: boolean; language: string };
function VoiceModelCard() {
  const [cfg, setCfg] = useState<VoiceCfg | null>(null);
  const toast = useToast();
  function load() {
    fetch('/api/voice/config').then((r) => r.json()).then(setCfg).catch(() => undefined);
  }
  useEffect(() => { load(); }, []);
  if (!cfg) return null;

  async function setEngine(engine: string) {
    setCfg((c) => (c ? { ...c, engine } : c));
    const r = await fetch('/api/voice/engine', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine }) });
    if (r.ok) toast('success', 'Voice engine saved');
  }
  async function setCleanup(cleanup: boolean) {
    setCfg((c) => (c ? { ...c, cleanup } : c));
    await fetch('/api/voice/cleanup', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cleanup }) });
  }
  async function saveLang(language: string) {
    setCfg((c) => (c ? { ...c, language } : c));
    await fetch('/api/voice/language', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language }) });
  }

  return (
    <AccordionCard title="Voice input" icon={Mic}>
      <p className="text-sm text-zinc-500 mb-4">
        Powers the mic everywhere (chat, brain-dump, story, notes) and your Telegram voice notes. Records your audio and transcribes it with a high-accuracy engine — far better than the old browser mic.
      </p>
      <div className="space-y-2">
        {cfg.engines.map((e) => (
          <label key={e.id} className={'flex items-start gap-3 rounded-lg border p-3 ' + (e.configured ? 'cursor-pointer ' : 'opacity-60 ') + (cfg.engine === e.id ? 'border-emerald-500 bg-emerald-500/5' : 'border-zinc-200 dark:border-zinc-800')}>
            <input type="radio" name="voiceEngine" disabled={!e.configured} checked={cfg.engine === e.id} onChange={() => setEngine(e.id)} className="mt-1 accent-emerald-600" />
            <div className="min-w-0">
              <div className="text-sm font-medium">{e.name}</div>
              <div className="text-xs text-zinc-500">{e.configured ? 'Ready' : 'Add this provider’s API key in Integrations to use it'}</div>
            </div>
          </label>
        ))}
      </div>
      <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 mt-3 cursor-pointer">
        <div>
          <div className="text-sm font-medium">Clean up my dictation</div>
          <div className="text-xs text-zinc-500">Auto punctuation &amp; capitals, removes “um/uh”, tidies sentences — keeps your words.</div>
        </div>
        <input type="checkbox" checked={cfg.cleanup} onChange={(e) => setCleanup(e.target.checked)} className="h-4 w-4 accent-emerald-600 shrink-0" />
      </label>
      <label className="text-sm text-zinc-600 dark:text-zinc-400 block mt-3">
        Spoken language <span className="text-zinc-400">(optional — helps accuracy)</span>
        <input
          value={cfg.language}
          onChange={(e) => setCfg((c) => (c ? { ...c, language: e.target.value } : c))}
          onBlur={(e) => saveLang(e.target.value.trim())}
          placeholder="e.g. en for English (blank = auto-detect)"
          className="w-full mt-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
        />
      </label>
    </AccordionCard>
  );
}

type PromptItem = { key: string; label: string; description: string; default: string; value: string; customized: boolean };

function PromptsSection() {
  const [items, setItems] = useState<PromptItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();

  async function load() {
    const r = await fetch('/api/prompts').then((x) => x.json()).catch(() => ({ prompts: [] }));
    const list: PromptItem[] = r.prompts || [];
    setItems(list);
    setDrafts(Object.fromEntries(list.map((p) => [p.key, p.value])));
    setLoaded(true);
  }
  useEffect(() => {
    load();
  }, []);
  if (!loaded) return null;

  async function save(key: string) {
    const r = await fetch(`/api/prompts/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: drafts[key] }) });
    if (r.ok) {
      toast('success', 'Prompt saved');
      load();
    } else toast('error', 'Could not save');
  }
  async function reset(key: string) {
    const r = await fetch(`/api/prompts/${key}/reset`, { method: 'POST' });
    if (r.ok) {
      toast('success', 'Reset to default');
      const d = await r.json();
      setDrafts((prev) => ({ ...prev, [key]: d.value }));
      load();
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <h2 className="flex items-center gap-2 font-semibold mb-1"><MessageSquare size={18} className="text-emerald-600" /> AI prompts</h2>
        <p className="text-sm text-zinc-500">Tune the exact instructions the AI follows across the app. Your edits apply immediately; the dynamic data (your dump, your day's tasks, etc.) is added automatically below each instruction. Use <b>Reset</b> any time to restore the original.</p>
      </section>

      {items.map((p) => {
        const dirty = drafts[p.key] !== p.value;
        return (
          <AccordionCard
            key={p.key}
            title={p.label}
            icon={MessageSquare}
            badge={p.customized ? <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-600 bg-amber-500/10 rounded px-1.5 py-0.5">customized</span> : undefined}
          >
            <p className="text-xs text-zinc-500 mb-2">{p.description}</p>
            <textarea
              value={drafts[p.key] ?? ''}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [p.key]: e.target.value }))}
              rows={Math.min(16, Math.max(5, (drafts[p.key] || '').split('\n').length + 1))}
              className="w-full resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs font-mono leading-relaxed outline-none focus:border-emerald-500"
            />
            <div className="mt-2 flex items-center justify-between">
              <button onClick={() => reset(p.key)} title="Reset to default" className="text-xs text-zinc-400 hover:text-rose-600 inline-flex items-center gap-1"><RotateCcw size={12} /> reset</button>
              <button onClick={() => save(p.key)} disabled={!dirty} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">Save</button>
            </div>
          </AccordionCard>
        );
      })}
    </div>
  );
}

function TelegramCard() {
  const [st, setSt] = useState<{ configured: boolean; linked: boolean; username: string | null; webhookOk: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function load() {
    const r = await fetch('/api/telegram/status').then((x) => x.json()).catch(() => null);
    setSt(r);
  }
  useEffect(() => {
    load();
  }, []);

  async function connect() {
    setBusy(true);
    try {
      const r = await fetch('/api/telegram/connect', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) toast('success', 'Telegram connected');
      else toast('error', d.message || 'Could not connect — is the bot token saved under Integrations?');
      load();
    } finally {
      setBusy(false);
    }
  }
  async function unlink() {
    const r = await fetch('/api/telegram/disconnect', { method: 'POST' });
    if (r.ok) {
      toast('success', 'Unlinked — send /start again to re-claim');
      load();
    }
  }

  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1">
        <Send size={18} className="text-sky-500" /> Telegram bot
      </h2>
      <p className="text-sm text-zinc-500 mb-4">
        Run your whole daily loop from Telegram — dump, story, notes, tasks, and all your nudges. Paste the bot token under <b>Integrations → Telegram</b> first, then connect here.
      </p>
      {!st ? (
        <p className="text-xs text-zinc-400">Checking…</p>
      ) : (
        <>
          <div className="text-sm space-y-1 mb-4">
            <div className="flex items-center gap-2"><span className={st.configured ? 'text-emerald-600' : 'text-zinc-400'}>{st.configured ? '●' : '○'}</span> Bot token {st.configured ? 'saved' : 'not set'}</div>
            <div className="flex items-center gap-2"><span className={st.webhookOk ? 'text-emerald-600' : 'text-zinc-400'}>{st.webhookOk ? '●' : '○'}</span> Webhook {st.webhookOk ? 'registered' : 'not registered'}</div>
            <div className="flex items-center gap-2"><span className={st.linked ? 'text-emerald-600' : 'text-zinc-400'}>{st.linked ? '●' : '○'}</span> {st.linked ? 'Linked to your chat' : 'Not linked yet'}</div>
            {st.username && <div className="text-xs text-zinc-400 pt-1">Your bot: <b>@{st.username}</b> — open it in Telegram and send <code>/start</code>.</div>}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={connect} disabled={busy || !st.configured} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
              {busy ? 'Connecting…' : st.webhookOk ? 'Re-register' : 'Connect'}
            </button>
            {st.linked && <button onClick={unlink} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Unlink</button>}
          </div>
        </>
      )}
    </section>
  );
}

/** Insights pull, not push (BEA-527): the notes are always in the app — these only control proactive pings. */
function NudgesCard() {
  const [prefs, setPrefs] = useState<{ mentorPush: boolean; storyReminder: boolean } | null>(null);
  const toast = useToast();
  useEffect(() => {
    fetch('/api/daily/nudges').then((r) => r.json()).then(setPrefs).catch(() => setPrefs(null));
  }, []);
  async function set(patch: { mentorPush?: boolean; storyReminder?: boolean }) {
    const next = { ...(prefs || { mentorPush: true, storyReminder: true }), ...patch };
    setPrefs(next);
    const r = await fetch('/api/daily/nudges', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => null);
    if (r?.ok) toast('success', 'Saved'); else toast('error', 'Could not save');
  }
  if (!prefs) return null;
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1"><BellRing size={18} className="text-amber-500" /> Nudges</h2>
      <p className="text-sm text-zinc-500 mb-4">Your Mentor note and story are <b>always waiting for you in the app</b> — these just decide what gets pushed to Telegram. Turn them off for a quieter, pull-when-you-want experience. We never nag about a missed day.</p>
      <label className="flex items-start gap-2.5 text-sm cursor-pointer py-1.5">
        <input type="checkbox" checked={prefs.mentorPush} onChange={(e) => set({ mentorPush: e.target.checked })} className="mt-0.5 h-4 w-4 accent-emerald-600" />
        <span><span className="font-medium">Send my nightly Mentor note on Telegram</span><br /><span className="text-xs text-zinc-500">Off = the note is still written each day and ready under Mentor — it just won't ping you.</span></span>
      </label>
      <label className="flex items-start gap-2.5 text-sm cursor-pointer py-1.5">
        <input type="checkbox" checked={prefs.storyReminder} onChange={(e) => set({ storyReminder: e.target.checked })} className="mt-0.5 h-4 w-4 accent-emerald-600" />
        <span><span className="font-medium">Morning nudge if yesterday's story isn't in</span><br /><span className="text-xs text-zinc-500">Off = no morning ping. At most one gentle reminder a day either way — never a guilt-trip.</span></span>
      </label>
    </section>
  );
}

function ChatRetentionCard() {
  const [months, setMonths] = useState(2);
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();
  useEffect(() => {
    fetch('/api/chat/retention').then((r) => r.json()).then((d) => setMonths(typeof d.months === 'number' ? d.months : 2)).catch(() => undefined).finally(() => setLoaded(true));
  }, []);
  if (!loaded) return null;
  async function save(v: number) {
    setMonths(v);
    const r = await fetch('/api/chat/retention', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ months: v }) });
    if (r.ok) toast('success', 'Chat retention saved');
  }
  const OPTS = [
    { v: 1, label: '1 month' },
    { v: 2, label: '2 months' },
    { v: 3, label: '3 months' },
    { v: 6, label: '6 months' },
    { v: 12, label: '12 months' },
    { v: 0, label: 'Keep forever' },
  ];
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1">
        <MessageSquare size={18} className="text-emerald-600" /> Chat history
      </h2>
      <p className="text-sm text-zinc-500 mb-4">How long to keep your chat threads before they're auto-cleaned. <b>Pinned threads and starred messages are always kept.</b></p>
      <label className="flex items-center justify-between py-1">
        <span className="text-sm">Keep threads for</span>
        <select value={months} onChange={(e) => save(Number(e.target.value))} className="rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">
          {OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </label>
    </section>
  );
}

/** Server-to-server document ingest token + curl example (BEA-535). */
function DocumentIngestCard() {
  const [cfg, setCfg] = useState<{ token: string; url: string } | null>(null);
  const [show, setShow] = useState(false);
  const [regen, setRegen] = useState(false);
  const toast = useToast();
  useEffect(() => {
    fetch('/api/documents/ingest-token').then((r) => r.json()).then(setCfg).catch(() => setCfg(null));
  }, []);
  async function regenerate() {
    setRegen(false);
    const r = await fetch('/api/documents/ingest-token/regenerate', { method: 'POST' });
    if (r.ok) {
      setCfg(await r.json());
      toast('success', 'New token — update your other servers');
    } else toast('error', 'Could not regenerate');
  }
  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => toast('success', `${label} copied`)).catch(() => toast('error', 'Could not copy'));
  }
  if (!cfg) return null;
  const masked = show ? cfg.token : cfg.token.slice(0, 6) + '••••••••••••••••' + cfg.token.slice(-4);
  const curl = `curl -X POST ${cfg.url} \\\n  -H "X-Ingest-Token: ${cfg.token}" \\\n  -F "file=@/path/to/document.md" \\\n  -F "originServer=$(hostname)"`;
  const inp = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono';
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1"><FileText size={18} className="text-emerald-600" /> Documents — server upload</h2>
      <p className="text-sm text-zinc-500 mb-4">Let your other servers drop files straight into Documents. Keep this token secret — anyone with it can upload. Send it as an <code>X-Ingest-Token</code> header (or <code>Authorization: Bearer</code>).</p>
      <label className="block text-xs text-zinc-500 mb-1">Endpoint</label>
      <div className="flex gap-2 mb-3">
        <input readOnly value={cfg.url} className={inp} />
        <button onClick={() => copy(cfg.url, 'URL')} className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 text-sm">Copy</button>
      </div>
      <label className="block text-xs text-zinc-500 mb-1">Token</label>
      <div className="flex gap-2 mb-3">
        <input readOnly value={masked} className={inp} />
        <button onClick={() => setShow((s) => !s)} className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 text-sm">{show ? 'Hide' : 'Show'}</button>
        <button onClick={() => copy(cfg.token, 'Token')} className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 text-sm">Copy</button>
      </div>
      <label className="block text-xs text-zinc-500 mb-1">Example (upload a file from another server)</label>
      <pre className="rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs font-mono overflow-x-auto whitespace-pre">{curl}</pre>
      <div className="mt-4 flex justify-between">
        <button onClick={() => copy(curl, 'Command')} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Copy command</button>
        <button onClick={() => setRegen(true)} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-rose-500 hover:border-rose-400">Regenerate token</button>
      </div>
      <ConfirmDialog open={regen} title="Regenerate the token?" message="The old token stops working immediately — any server still using it will be rejected until you update it." confirmLabel="Regenerate" onCancel={() => setRegen(false)} onConfirm={regenerate} />
    </section>
  );
}

function SyncSection() {
  return (
    <div className="space-y-4">
      <TelegramCard />
      <NudgesCard />
      <DocumentIngestCard />
      <ChatRetentionCard />
      <RaindropSyncCard />
      <SkillsSyncCard />
      <SuperMemorySyncCard />
    </div>
  );
}

function SkillsSyncCard() {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    fetch('/api/skills/scan-status')
      .then((r) => r.json())
      .then((d) => setLast(d.lastScan))
      .catch(() => undefined);
  }, []);
  async function run() {
    setBusy(true);
    try {
      const r = await fetch('/api/skills/scan', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        toast('success', `Synced — ${d.created} new, ${d.updated} updated (${d.total} found)`);
        if (d.lastScan) setLast(d.lastScan);
      } else toast('error', d.message || 'Scan failed');
    } catch {
      toast('error', 'Scan failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1">
        <Wand2 size={18} className="text-violet-500" /> Sync Claude skills
      </h2>
      <p className="text-sm text-zinc-500 mb-4">
        Scan your server's Claude Code skills (<code>~/.claude/skills</code>) and pull in new ones — each described by AI and packaged for download.
      </p>
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={run} disabled={busy} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
        <span className="text-xs text-zinc-400">{last ? `Last synced: ${new Date(last).toLocaleString()}` : 'Never synced yet'}</span>
      </div>
    </section>
  );
}

function RaindropSyncCard() {
  const INTERVALS = [
    { v: 60, label: 'Every hour' },
    { v: 360, label: 'Every 6 hours' },
    { v: 1440, label: 'Once a day' },
  ];
  const [enabled, setEnabled] = useState(true);
  const [intervalM, setIntervalM] = useState(60);
  const [status, setStatus] = useState<{ lastSync: string | null; count: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();

  useEffect(() => {
    Promise.all([
      fetch('/api/bookmarks/autosync').then((r) => r.json()).catch(() => ({})),
      fetch('/api/bookmarks/status').then((r) => r.json()).catch(() => ({})),
    ])
      .then(([a, s]) => {
        if (typeof a.enabled === 'boolean') setEnabled(a.enabled);
        if (a.intervalMinutes) setIntervalM(a.intervalMinutes);
        setStatus(s);
      })
      .finally(() => setLoaded(true));
  }, []);
  if (!loaded) return null;

  async function save(next: { enabled?: boolean; intervalMinutes?: number }) {
    const body = { enabled: next.enabled ?? enabled, intervalMinutes: next.intervalMinutes ?? intervalM };
    const r = await fetch('/api/bookmarks/autosync', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) toast('success', 'Auto-sync settings saved');
    else toast('error', 'Could not save');
  }

  const sel = 'mt-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm';
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1">
        <Bookmark size={18} className="text-emerald-600" /> Raindrop bookmarks
      </h2>
      <p className="text-sm text-zinc-500 mb-4">
        Automatically pull your latest Raindrop bookmarks (last 3 months) and summarize them. You can also sync manually on the Bookmarks page.
      </p>
      <label className="flex items-center justify-between py-2">
        <span className="text-sm">Auto-sync</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            save({ enabled: e.target.checked });
          }}
          className="h-4 w-4 accent-emerald-600"
        />
      </label>
      <label className="flex items-center justify-between py-2">
        <span className="text-sm">How often</span>
        <select
          disabled={!enabled}
          value={intervalM}
          onChange={(e) => {
            const v = Number(e.target.value);
            setIntervalM(v);
            save({ intervalMinutes: v });
          }}
          className={sel + (enabled ? '' : ' opacity-50')}
        >
          {INTERVALS.map((i) => (
            <option key={i.v} value={i.v}>{i.label}</option>
          ))}
        </select>
      </label>
      <p className="text-xs text-zinc-400 mt-2">
        {status?.count ? `${status.count} bookmarks` : 'No bookmarks yet'}
        {status?.lastSync ? ` · last synced ${new Date(status.lastSync).toLocaleString()}` : ' · never synced'}
      </p>
    </section>
  );
}

function BookmarksModelCard() {
  const FALLBACK = [
    { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
    { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro Preview' },
    { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  ];
  const [opts, setOpts] = useState<{ id: string; name: string }[]>([]);
  const [model, setModel] = useState('');
  const [custom, setCustom] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();

  useEffect(() => {
    Promise.all([
      fetch('/api/bookmarks/model').then((r) => r.json()).catch(() => ({})),
      fetch('/api/bookmarks/models').then((r) => r.json()).catch(() => ({ models: [] })),
    ])
      .then(([cfg, list]) => {
        const models = ((list.models || []) as { id: string; name: string }[]);
        const finalOpts = models.length ? models : FALLBACK;
        setOpts(finalOpts);
        const m = cfg.model || '';
        setModel(m);
        setCustom(!!m && !finalOpts.some((o) => o.id === m));
      })
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!loaded) return null;

  async function save() {
    const r = await fetch('/api/bookmarks/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    if (r.ok) toast('success', 'Bookmarks model saved');
    else toast('error', (await r.json().catch(() => ({}))).message || 'Could not save');
  }

  const sel = 'w-full mt-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm';
  return (
    <AccordionCard title="Bookmarks AI model" icon={Bookmark}>
      <p className="text-sm text-zinc-500 mb-4">
        Used only to summarize your bookmarks (separate from the default model above). YouTube links are watched &amp; summarized natively — pick a Gemini model. Uses your OpenRouter key.
      </p>
      <label className="text-sm text-zinc-600 dark:text-zinc-400 block">
        Model
        <select
          value={custom ? '__custom__' : model}
          onChange={(e) => {
            if (e.target.value === '__custom__') {
              setCustom(true);
              setModel('');
            } else {
              setCustom(false);
              setModel(e.target.value);
            }
          }}
          className={sel}
        >
          <option value="">Choose…</option>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
      </label>
      {custom && (
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="openrouter model id (e.g. google/gemini-3-pro-preview)"
          className="mt-3 w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
        />
      )}
      <div className="mt-4 text-right">
        <button onClick={save} disabled={!model} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
          Save
        </button>
      </div>
    </AccordionCard>
  );
}

function TasksModelCard() {
  const FALLBACK = [
    { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (recommended)' },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
    { id: 'openai/gpt-4o', name: 'GPT-4o' },
  ];
  const [opts, setOpts] = useState<{ id: string; name: string }[]>([]);
  const [model, setModel] = useState('');
  const [custom, setCustom] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();

  useEffect(() => {
    Promise.all([
      fetch('/api/tasks/model').then((r) => r.json()).catch(() => ({})),
      fetch('/api/tasks/models').then((r) => r.json()).catch(() => ({ models: [] })),
    ])
      .then(([cfg, list]) => {
        const models = ((list.models || []) as { id: string; name: string }[]);
        const finalOpts = models.length ? models : FALLBACK;
        setOpts(finalOpts);
        const m = cfg.model || '';
        setModel(m);
        setCustom(!!m && !finalOpts.some((o) => o.id === m));
      })
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!loaded) return null;

  async function save() {
    const r = await fetch('/api/tasks/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    if (r.ok) toast('success', 'Tasks model saved');
    else toast('error', (await r.json().catch(() => ({}))).message || 'Could not save');
  }

  const sel = 'w-full mt-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm';
  return (
    <AccordionCard title="Tasks AI model" icon={CheckSquare}>
      <p className="text-sm text-zinc-500 mb-4">
        Runs the whole Tasks engine — turning your brain-dump into tasks and (later) understanding you. Only OpenAI &amp; Anthropic models are shown. Defaults to Claude Sonnet. Uses your OpenRouter key.
      </p>
      <label className="text-sm text-zinc-600 dark:text-zinc-400 block">
        Model
        <select
          value={custom ? '__custom__' : model}
          onChange={(e) => {
            if (e.target.value === '__custom__') {
              setCustom(true);
              setModel('');
            } else {
              setCustom(false);
              setModel(e.target.value);
            }
          }}
          className={sel}
        >
          <option value="">Choose…</option>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
      </label>
      {custom && (
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="openrouter model id (e.g. anthropic/claude-sonnet-4.6)"
          className="mt-3 w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
        />
      )}
      <div className="mt-4 text-right">
        <button onClick={save} disabled={!model} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
          Save
        </button>
      </div>
    </AccordionCard>
  );
}

function SuperMemorySyncCard() {
  const [busy, setBusy] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    fetch('/api/items/supermemory-sync-status')
      .then((r) => r.json())
      .then((d) => setLastSync(d.lastSync))
      .catch(() => undefined);
  }, []);

  async function run() {
    setBusy(true);
    try {
      const r = await fetch('/api/items/import-supermemory', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        toast('success', `Imported ${d.imported} new document${d.imported === 1 ? '' : 's'} (${d.skipped} already here)`);
        if (d.lastSync) setLastSync(d.lastSync);
      } else toast('error', 'Sync failed');
    } catch {
      toast('error', 'Sync failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1">
        <Brain size={18} className="text-indigo-500" /> Sync from SuperMemory
      </h2>
      <p className="text-sm text-zinc-500 mb-4">
        Pull everything you've saved to SuperMemory (Claude Code, Claude chat, etc.) into your documents — as cards you can view, chat with, and manage.
      </p>
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={run} disabled={busy} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
        <span className="text-xs text-zinc-400">{lastSync ? `Last synced: ${new Date(lastSync).toLocaleString()}` : 'Never synced yet'}</span>
      </div>
    </section>
  );
}

type GServices = { connected: boolean; email: string | null; project: string | null; services: { key: string; label: string; access: string; enabled: boolean; unsupported: boolean }[] };

/** The dedicated Google tab — every Workspace service and its access level. */
function GoogleServicesSection() {
  const [d, setD] = useState<GServices | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const r = await fetch('/api/google/services');
      if (r.ok) setD(await r.json());
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { load(); }, []);
  const badge = (s: { access: string; unsupported: boolean }) => {
    if (s.unsupported) return <span className="text-[11px] rounded-full bg-rose-500/10 text-rose-600 px-2 py-0.5">Not available</span>;
    if (s.access === 'read-write') return <span className="text-[11px] rounded-full bg-emerald-500/10 text-emerald-600 px-2 py-0.5">Read &amp; write</span>;
    if (s.access === 'read-only') return <span className="text-[11px] rounded-full bg-amber-500/10 text-amber-600 px-2 py-0.5">Read only</span>;
    return <span className="text-[11px] rounded-full bg-zinc-500/10 text-zinc-500 px-2 py-0.5">Off</span>;
  };
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-semibold"><Globe size={18} className="text-blue-500" /> Google Workspace</h2>
          <button onClick={load} disabled={busy} className="text-xs text-zinc-400 hover:text-blue-500">{busy ? '…' : 'refresh'}</button>
        </div>
        {!d ? (
          <p className="mt-3 text-sm text-zinc-400">Loading…</p>
        ) : !d.connected ? (
          <div className="mt-3 text-sm rounded-lg bg-amber-500/10 border border-amber-300/30 dark:border-amber-500/20 px-3 py-2 text-amber-700 dark:text-amber-300">
            Not connected yet. Go to <b>Settings → Integrations → Google</b> to connect.
          </div>
        ) : (
          <>
            <p className="mt-1 mb-3 text-sm text-zinc-500">Connected as <b className="text-zinc-700 dark:text-zinc-200">{d.email || 'your Google account'}</b>{d.project ? <> · project <code className="text-zinc-400">{d.project}</code></> : ''}.</p>
            <div className="rounded-lg border border-zinc-100 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.services.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm">
                  <span className={s.enabled ? 'font-medium' : 'text-zinc-400'}>{s.label}</span>
                  {badge(s)}
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-zinc-400">“Read &amp; write” = the app can read your data and create new items, but never sends, edits, or deletes your existing Google content. <b>Keep</b> isn’t available through a personal Google sign-in (Google restricts it to enterprise service accounts).</p>
          </>
        )}
      </section>
    </div>
  );
}

type GoogleStatus = { connected: boolean; email: string | null; gws: boolean; bridge: boolean };

/** Google Workspace setup — connects Gmail/Drive/Docs/Sheets via the gws CLI on your server. */
function GoogleCard() {
  const [s, setS] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const r = await fetch('/api/google/status');
      if (r.ok) setS(await r.json());
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { load(); }, []);
  const Step = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
    <li className="flex items-center gap-2 text-sm">
      <span className={ok ? 'text-emerald-500' : 'text-zinc-400'}>{ok ? '✓' : '○'}</span>
      <span className={ok ? 'text-zinc-700 dark:text-zinc-200' : 'text-zinc-500'}>{children}</span>
    </li>
  );
  const code = 'rounded bg-zinc-200 dark:bg-zinc-800 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400';
  return (
    <div className="rounded-xl border border-blue-300/40 dark:border-blue-500/30 bg-gradient-to-br from-blue-500/5 to-transparent p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-bold flex items-center gap-2">🟦 Google Workspace <span className="text-[10px] uppercase tracking-wide rounded-full bg-blue-500/15 text-blue-500 px-2 py-0.5">setup</span></h3>
          <p className="text-xs text-zinc-500 mt-1">Pull your <b>Gmail, Drive, Docs &amp; Sheets</b> into your brain via the Google Workspace CLI (<code className="text-zinc-500">gws</code>) on your server — read &amp; safe-write. Google sign-in is handled by the CLI.</p>
        </div>
        <button onClick={load} disabled={busy} className="text-xs text-zinc-400 hover:text-blue-500 shrink-0">{busy ? '…' : 'refresh'}</button>
      </div>
      {!s ? (
        <p className="mt-3 text-sm text-zinc-400">Checking your server…</p>
      ) : (
        <>
          <ul className="mt-3 space-y-1.5">
            <Step ok={s.bridge}>Server bridge reachable</Step>
            <Step ok={s.gws}>Google Workspace CLI installed on your server</Step>
            <Step ok={s.connected}>Connected to your Google account{s.email ? ` (${s.email})` : ''}</Step>
          </ul>
          {!s.connected && (
            <div className="mt-3 text-xs rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-3 py-2.5 space-y-1.5">
              <p className="text-zinc-600 dark:text-zinc-300 font-medium">One step only you can do — connect your Google account on the server:</p>
              <p className="text-zinc-500">Easiest (uses gcloud to auto-create the Google app + sign in): run <code className={code}>gws auth setup</code></p>
              <p className="text-zinc-500">Or, if you’ve placed a client_secret.json in <code className={code}>~/.config/gws/</code>: run <code className={code}>gws auth login</code></p>
              <p className="text-zinc-500">It’ll ask for Gmail, Drive, Docs &amp; Sheets access. On a headless server use the printed URL/device-code flow. Then tap “refresh”.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type CodexStatus = { connected: boolean; installed: boolean; version: string | null; loggedIn: boolean; ready: boolean; workdir: string | null; reason?: string };

/** Codex agent setup — connects your server's Codex (on your ChatGPT subscription) for running tasks. */
function CodexCard() {
  const [s, setS] = useState<CodexStatus | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const r = await fetch('/api/codex/status');
      if (r.ok) setS(await r.json());
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { load(); }, []);

  const Step = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
    <li className="flex items-center gap-2 text-sm">
      <span className={ok ? 'text-emerald-500' : 'text-zinc-400'}>{ok ? '✓' : '○'}</span>
      <span className={ok ? 'text-zinc-700 dark:text-zinc-200' : 'text-zinc-500'}>{children}</span>
    </li>
  );

  return (
    <div className="rounded-xl border border-indigo-300/40 dark:border-indigo-500/30 bg-gradient-to-br from-indigo-500/5 to-transparent p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-bold flex items-center gap-2">🤖 Codex agent <span className="text-[10px] uppercase tracking-wide rounded-full bg-indigo-500/15 text-indigo-500 px-2 py-0.5">setup</span></h3>
          <p className="text-xs text-zinc-500 mt-1">Let your server run tasks for you using <b>Codex on your ChatGPT subscription</b> — no separate API bill, your Claude account untouched.</p>
        </div>
        <button onClick={load} disabled={busy} className="text-xs text-zinc-400 hover:text-indigo-500 shrink-0">{busy ? '…' : 'refresh'}</button>
      </div>

      {!s ? (
        <p className="mt-3 text-sm text-zinc-400">Checking your server…</p>
      ) : !s.connected ? (
        <div className="mt-3 text-sm rounded-lg bg-amber-500/10 border border-amber-300/30 dark:border-amber-500/20 px-3 py-2 text-amber-700 dark:text-amber-300">
          The server bridge isn’t reachable yet{ s.reason ? ` (${s.reason})` : '' }. It comes online with the next deploy.
        </div>
      ) : (
        <>
          <ul className="mt-3 space-y-1.5">
            <Step ok={s.installed}>Codex installed on your server{s.version ? ` (${s.version})` : ''}</Step>
            <Step ok={s.loggedIn}>Connected to your ChatGPT / Codex subscription</Step>
            <Step ok={s.ready}>Ready to run tasks</Step>
          </ul>
          {!s.loggedIn && (
            <div className="mt-3 text-xs rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
              <p className="text-zinc-600 dark:text-zinc-300 mb-1.5 font-medium">One step only you can do — sign Codex into your subscription:</p>
              <p className="text-zinc-500">On your server, run <code className="rounded bg-zinc-200 dark:bg-zinc-800 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">codex login</code> and follow the link to authorise it with your ChatGPT account. Then tap “refresh” above.</p>
            </div>
          )}
          {s.ready && (
            <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">✓ Your server agent is connected. Running tasks from the app is the next thing we’ll switch on — carefully, inside a safe folder.</p>
          )}
          {s.workdir && <p className="mt-2 text-[11px] text-zinc-400">Sandbox folder: <code>{s.workdir}</code> — the agent will be confined here.</p>}
        </>
      )}
    </div>
  );
}

type GeminiStatus = { connected: boolean; installed: boolean; version: string | null; loggedIn: boolean; ready: boolean; workdir: string | null; reason?: string };

/** Gemini / Antigravity CLI agent setup — connects your server's `agy` (on your Google AI Pro/Ultra plan). */
function GeminiCard() {
  const [s, setS] = useState<GeminiStatus | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const r = await fetch('/api/gemini/status');
      if (r.ok) setS(await r.json());
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { load(); }, []);

  const Step = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
    <li className="flex items-center gap-2 text-sm">
      <span className={ok ? 'text-emerald-500' : 'text-zinc-400'}>{ok ? '✓' : '○'}</span>
      <span className={ok ? 'text-zinc-700 dark:text-zinc-200' : 'text-zinc-500'}>{children}</span>
    </li>
  );

  return (
    <div className="rounded-xl border border-sky-300/40 dark:border-sky-500/30 bg-gradient-to-br from-sky-500/5 to-transparent p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-bold flex items-center gap-2">✦ Gemini agent <span className="text-[10px] uppercase tracking-wide rounded-full bg-sky-500/15 text-sky-500 px-2 py-0.5">setup</span></h3>
          <p className="text-xs text-zinc-500 mt-1">Let your server run tasks using <b>Google's Antigravity CLI on your Gemini AI Pro/Ultra plan</b> — a second agent alongside Codex, on your own subscription.</p>
        </div>
        <button onClick={load} disabled={busy} className="text-xs text-zinc-400 hover:text-sky-500 shrink-0">{busy ? '…' : 'refresh'}</button>
      </div>

      {!s ? (
        <p className="mt-3 text-sm text-zinc-400">Checking your server…</p>
      ) : !s.connected ? (
        <div className="mt-3 text-sm rounded-lg bg-amber-500/10 border border-amber-300/30 dark:border-amber-500/20 px-3 py-2 text-amber-700 dark:text-amber-300">
          The server bridge isn’t reachable yet{s.reason ? ` (${s.reason})` : ''}. It comes online with the next deploy.
        </div>
      ) : (
        <>
          <ul className="mt-3 space-y-1.5">
            <Step ok={s.installed}>Antigravity CLI installed on your server{s.version ? ` (v${s.version})` : ''}</Step>
            <Step ok={s.loggedIn}>Connected to your Google AI Pro/Ultra plan</Step>
            <Step ok={s.ready}>Ready to run tasks</Step>
          </ul>
          {!s.loggedIn && (
            <div className="mt-3 text-xs rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
              <p className="text-zinc-600 dark:text-zinc-300 mb-1.5 font-medium">One step only you can do — sign Gemini into your plan:</p>
              <p className="text-zinc-500">On your server, run <code className="rounded bg-zinc-200 dark:bg-zinc-800 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">agy</code>, open the sign-in link it prints, and authorise it with your <b>Google AI Pro/Ultra</b> account. Then tap “refresh” above.</p>
            </div>
          )}
          {s.ready && (
            <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">✓ Your Gemini agent is connected. Running tasks from the app is the next thing we’ll switch on — carefully, inside a safe folder.</p>
          )}
          {s.workdir && <p className="mt-2 text-[11px] text-zinc-400">Sandbox folder: <code>{s.workdir}</code> — the agent will be confined here.</p>}
        </>
      )}
    </div>
  );
}

/** Server-side CLI agents (run tasks on your own subscriptions) — kept separate from data connectors. */
function CliSection() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <h2 className="flex items-center gap-2 font-semibold mb-1">
          <Terminal size={18} className="text-emerald-600" /> Command-line agents
        </h2>
        <p className="text-sm text-zinc-500">
          AI agents that live on your server and can run tasks for you — each on <b>your own subscription</b>, so there's no separate API bill. Sign each one into its account below.
        </p>
      </div>
      <CodexCard />
      <GeminiCard />
    </div>
  );
}

function IntegrationsSection() {
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Integration | null>(null);
  const [disconnecting, setDisconnecting] = useState<Integration | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const toast = useToast();

  async function test(it: Integration) {
    setTesting(it.name);
    try {
      const r = await fetch(`/api/connectors/${it.name}/test`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (d.ok) toast('success', d.message || `${it.label} works`);
      else toast('error', d.message || `${it.label} test failed`);
    } catch {
      toast('error', `Could not test ${it.label}`);
    } finally {
      setTesting(null);
    }
  }

  async function refresh() {
    const r = await fetch('/api/connectors');
    if (r.ok) {
      const d = await r.json();
      const m: Record<string, boolean> = {};
      (d.connectors || []).forEach((c: any) => (m[c.name] = c.configured));
      setStatus(m);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function disconnect(it: Integration) {
    const r = await fetch(`/api/connectors/${it.name}`, { method: 'DELETE' });
    setDisconnecting(null);
    if (r.ok) {
      toast('success', `${it.label} disconnected`);
      refresh();
    } else toast('error', `Could not disconnect ${it.label}`);
  }

  return (
    <div className="space-y-4">
      <GoogleCard />
      <div className="grid sm:grid-cols-2 gap-3">
        {INTEGRATIONS.map((it) => {
          const managed = !!it.managed;
          const connected = managed || !!status[it.name];
          return (
            <div key={it.name} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600">
                    <it.icon size={18} />
                  </div>
                  <div>
                    <div className="font-semibold text-sm">{it.label}</div>
                    <div className="text-xs text-zinc-500">{it.desc}</div>
                  </div>
                </div>
                <span
                  className={
                    'text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ' +
                    (connected ? 'bg-emerald-500/15 text-emerald-500' : 'bg-zinc-500/15 text-zinc-400')
                  }
                >
                  {connected ? (
                    <span className="inline-flex items-center gap-1">
                      <Check size={11} /> {managed ? 'Connected · managed' : 'Connected'}
                    </span>
                  ) : (
                    'Not set'
                  )}
                </span>
              </div>
              <div className="mt-4 flex gap-2">
                {it.managed ? (
                  <span className="text-xs text-zinc-400">Managed automatically on your server.</span>
                ) : (
                  <>
                    <button
                      onClick={() => setEditing(it)}
                      className="text-sm rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5"
                    >
                      {connected ? 'Manage' : 'Connect'}
                    </button>
                    {it.testable && connected && (
                      <button
                        onClick={() => test(it)}
                        disabled={testing === it.name}
                        className="text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 disabled:opacity-50"
                      >
                        {testing === it.name ? 'Testing…' : 'Test'}
                      </button>
                    )}
                    {connected && (
                      <button
                        onClick={() => setDisconnecting(it)}
                        className="text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5"
                      >
                        Disconnect
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <ConnectModal
          integration={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast('success', `${editing.label} connected`);
            refresh();
          }}
          onError={() => toast('error', `Could not save ${editing.label}`)}
        />
      )}

      <ConfirmDialog
        open={!!disconnecting}
        title={`Disconnect ${disconnecting?.label ?? ''}?`}
        message="The stored key will be removed. You can reconnect anytime."
        confirmLabel="Disconnect"
        onCancel={() => setDisconnecting(null)}
        onConfirm={() => disconnecting && disconnect(disconnecting)}
      />
    </div>
  );
}

function ConnectModal({
  integration,
  onClose,
  onSaved,
  onError,
}: {
  integration: Integration;
  onClose: () => void;
  onSaved: () => void;
  onError: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const r = await fetch(`/api/connectors/${integration.name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (r.ok) onSaved();
      else onError();
    } catch {
      onError();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl">
        <h3 className="font-bold mb-1">Connect {integration.label}</h3>
        <p className="text-xs text-zinc-500 mb-4">{integration.desc}. Keys are stored encrypted and never shown again.</p>
        {(integration.fields || []).map((f) => (
          <label key={f.key} className="block mb-3 text-sm">
            <span className="block mb-1 text-zinc-600 dark:text-zinc-400">{f.label}</span>
            <input
              type={f.type || 'text'}
              autoComplete="off"
              value={values[f.key] || ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 outline-none focus:border-emerald-500"
            />
          </label>
        ))}
        <div className="flex justify-end gap-2 mt-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Activity: a holistic per-day calendar of every automatic run (BEA-471) ----------------
const STEPS: { key: keyof DayRun; label: string; short: string }[] = [
  { key: 'story', label: 'Story told', short: 'Story' },
  { key: 'wrapped', label: 'Day wrapped', short: 'Wrap' },
  { key: 'learned', label: 'Lab learned', short: 'Lab' },
  { key: 'mentor', label: 'Mentor', short: 'Mentor' },
  { key: 'summary', label: 'Summary', short: 'Summary' },
];

function prettyDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function LabActivitySection() {
  const [data, setData] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    mindApi.activity(30).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, []);

  const StatCard = ({ label, stat, empty }: { label: string; stat: RunStat; empty: string }) => (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-1">{label}</div>
      {stat?.at ? (
        <>
          <div className="text-sm font-medium">{fmtWhen(stat.at)}</div>
          <div className="text-[11px] text-zinc-400">{fmtRelative(stat.at)}{stat.detail ? ` · ${stat.detail}` : ''}</div>
        </>
      ) : (
        <div className="text-sm text-zinc-400">{empty}</div>
      )}
    </div>
  );

  if (loading) return <div className="text-sm text-zinc-400">Loading…</div>;
  if (!data) return <div className="text-sm text-zinc-400">Couldn't load activity.</div>;

  return (
    <section className="space-y-5 max-w-3xl">
      <div>
        <h2 className="flex items-center gap-2 font-semibold mb-1"><FlaskConical size={18} className="text-violet-500" /> Activity — did it run, and when?</h2>
        <p className="text-sm text-zinc-500">A day-by-day view of everything that runs automatically. All times are your time (IST). A ✓ means that step ran for that day.</p>
      </div>

      {/* Status board — when each thing last ran */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <StatCard label="Story last told" stat={data.status.story} empty="Not yet" />
        <StatCard label="Day last wrapped" stat={data.status.wrapped} empty="Not yet" />
        <StatCard label="Lab last learned" stat={data.status.learned} empty="Not yet" />
        <StatCard label="Mentor last ran" stat={data.status.mentor} empty="Not yet" />
        <StatCard label="Summary last ran" stat={data.status.summary} empty="Not yet" />
      </div>

      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-300">
        Next automatic wrap-up: <b>every day at {data.wrapAt} AM</b>. Telling a past day's story wraps it up right away; otherwise the 10:00 check does it (and nudges you if the story isn't in).
      </div>

      {/* The run calendar — per day, which steps happened */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-2">Run calendar (last 30 days)</div>
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-900/60 text-[11px] uppercase tracking-wide text-zinc-400">
                <th className="text-left font-semibold px-3 py-2 sticky left-0 bg-zinc-50 dark:bg-zinc-900/60">Day</th>
                {STEPS.map((s) => <th key={s.key} className="px-2 py-2 font-semibold text-center whitespace-nowrap">{s.short}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.days.map((d, i) => {
                const done = STEPS.filter((s) => d[s.key]).length;
                return (
                  <tr key={d.day} className={'border-t border-zinc-100 dark:border-zinc-800 ' + (i === 0 ? 'bg-violet-500/5' : '')}>
                    <td className="px-3 py-1.5 whitespace-nowrap sticky left-0 bg-white dark:bg-zinc-900">
                      <span className="font-medium">{prettyDay(d.day)}</span>
                      {i === 0 && <span className="ml-1.5 text-[10px] text-violet-500">today</span>}
                    </td>
                    {STEPS.map((s) => (
                      <td key={s.key} className="px-2 py-1.5 text-center">
                        {d[s.key] ? <span className="text-emerald-500" title={`${s.label} ✓`}>✓</span> : <span className="text-zinc-300 dark:text-zinc-700" title={`${s.label} — not run`}>–</span>}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-zinc-400 mt-1.5">Today's row often shows gaps — those steps run after you tell the story / at 10:00 AM. Older days with gaps are days you didn't log.</p>
      </div>

      {/* The detailed event log */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-2">Recent runs (detailed)</div>
        {data.runs.length === 0 ? (
          <div className="text-sm text-zinc-400">Nothing logged yet.</div>
        ) : (
          <div className="space-y-1.5">
            {data.runs.map((r) => {
              const k = RUN_KIND[r.kind] ?? { label: r.kind, tone: 'text-zinc-500' };
              return (
                <div key={r.id} className="flex items-start gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2">
                  <span className={'mt-0.5 text-[10px] font-semibold uppercase tracking-wide shrink-0 w-16 ' + k.tone}>{k.label}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">{r.detail}</div>
                    <div className="text-[11px] text-zinc-400">{fmtWhen(r.at)} · {fmtRelative(r.at)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
