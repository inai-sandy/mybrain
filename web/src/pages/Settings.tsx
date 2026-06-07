import { useEffect, useState } from 'react';
import { User, Plug, Palette, Brain, Database, FileText, Send, Bookmark, Globe, Sparkles, Boxes, Check, Cpu, RefreshCw, type LucideIcon } from 'lucide-react';
import { useTheme } from '../ui/theme';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';

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

type Tab = 'account' | 'integrations' | 'models' | 'sync' | 'appearance';

export function Settings({ email }: { email?: string }) {
  const [tab, setTab] = useState<Tab>('integrations');
  const tabs: { id: Tab; label: string; icon: LucideIcon }[] = [
    { id: 'account', label: 'Account', icon: User },
    { id: 'integrations', label: 'Integrations', icon: Plug },
    { id: 'models', label: 'Models', icon: Cpu },
    { id: 'sync', label: 'Sync', icon: RefreshCw },
    { id: 'appearance', label: 'Appearance', icon: Palette },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Settings</h1>
        <p className="text-zinc-500">Your account, connected services, and appearance.</p>
      </div>

      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              'flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ' +
              (tab === t.id
                ? 'border-emerald-600 text-emerald-600'
                : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100')
            }
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'account' && <AccountSection email={email} />}
      {tab === 'integrations' && <IntegrationsSection />}
      {tab === 'models' && <ModelsSection />}
      {tab === 'sync' && <SyncSection />}
      {tab === 'appearance' && <AppearanceSection />}
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
  );
}

function AppearanceSection() {
  const { theme, toggle } = useTheme();
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 max-w-xl">
      <h2 className="font-semibold mb-3">Appearance</h2>
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-500">Theme</span>
        <button onClick={toggle} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm capitalize">
          {theme} mode
        </button>
      </div>
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
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1">
        <Sparkles size={18} className="text-emerald-600" /> Default AI model
      </h2>
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
    </section>
  );
}

function ModelsSection() {
  return (
    <div className="space-y-4">
      <AiModelCard />
      <BookmarksModelCard />
    </div>
  );
}

function SyncSection() {
  return (
    <div className="space-y-4">
      <RaindropSyncCard />
      <SuperMemorySyncCard />
    </div>
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
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h2 className="flex items-center gap-2 font-semibold mb-1">
        <Bookmark size={18} className="text-emerald-600" /> Bookmarks AI model
      </h2>
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
    </section>
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
