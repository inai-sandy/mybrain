import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Check, Cable, ExternalLink, KeyRound, Loader2, Pencil, Plug, PlugZap, RefreshCw, Search, Trash2, X, Zap,
} from 'lucide-react';
import { Column, DataTable, Filter, SortOption } from '../ui/DataTable';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Sheet } from '../ui/Sheet';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { useUrlState } from '../ui/useUrlState';

/**
 * `/tools` — connect the outside services an agent can use (BEA-1346). Design: `specs/TOOLS.md`.
 *
 * Everything here goes through our own `/api/tools/services` endpoints, which sit on the
 * `ServiceProvider` seam. No vendor name appears in this file on purpose: the page must survive the
 * provider being swapped, and the owner should never have to learn who supplies GitHub.
 *
 * Three facts, all read off the live API, shape the whole screen:
 *  - **1,209 services.** Categories exist so the first visit is never a blank search box, and the
 *    list is browsed on the phone as often as the laptop — so it is cards at every width.
 *  - **Only 121 have a ready-made login.** "Bring your own key" is the COMMON case, not Vercel's
 *    oddity, so it gets a real form rather than an apology.
 *  - **32 need no sign-in at all**, and the vendor refuses to make a login config for one of them.
 *    Those say "ready to use" instead of offering a Connect button that could only ever fail.
 */

type Account = { id: string; label: string; status: string; connectedAt?: string; lastUsedAt?: string };
type Service = {
  slug: string;
  name: string;
  category: string;
  categories: string[];
  description?: string;
  logo?: string;
  actionCount?: number;
  triggerCount?: number;
  managedAuth?: boolean;
  noAuth?: boolean;
  connected: boolean;
  accounts: Account[];
  needsCount: number;
};
type CredField = { name: string; label: string; description?: string; required?: boolean; secret?: boolean };
type FullService = Service & { needs?: CredField[]; needsAuthConfig?: CredField[]; needsAccount?: CredField[]; authMode?: string };
type Status = { configured: boolean; reachable: boolean; message?: string; serviceCount?: number };
type Payload = { status: Status; services: Service[]; categories: { id: string; label: string; count: number }[]; connectedCount: number };

/** A row the table can search and sort — the array fields flattened into plain strings/numbers. */
type Row = Service & { _search: string; _actions: number; _triggers: number; _signin: string; _state: string };

/** The provider's word for a connection, in English. Never shown raw. */
const STATUS_WORDS: Record<string, string> = {
  ACTIVE: 'Working',
  INITIALIZING: 'Waiting for you to finish signing in',
  EXPIRED: 'Sign-in has expired',
  INACTIVE: 'Switched off',
  FAILED: 'Sign-in did not finish',
};
const statusWords = (s: string) => STATUS_WORDS[String(s || '').toUpperCase()] || 'Not working';
const isLive = (a: Account) => String(a.status || '').toUpperCase() === 'ACTIVE';
const isPending = (a: Account) => String(a.status || '').toUpperCase() === 'INITIALIZING';

function signInKind(s: Service): string {
  if (s.noAuth) return 'none';
  return s.managedAuth ? 'oneclick' : 'own';
}

const num = (n: number | undefined) => (Number.isFinite(n) ? Number(n) : 0);
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The service's own mark.
 *
 * Two things this has to survive. **70 of the 1,209 logo URLs 404**, and a broken-image icon in a
 * grid of 24 cards reads as "the page failed", so a missing one falls back to a letter. And the
 * tile stays LIGHT in dark mode on purpose: these are brand marks drawn for a white background —
 * GitHub, PostHog and Zendesk are all near-black, and on a dark tile they simply disappeared.
 */
function Logo({ s, size = 40 }: { s: Service; size?: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      className="shrink-0 grid place-items-center overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-100"
      style={{ width: size, height: size }}
    >
      {s.logo && !failed ? (
        <img src={s.logo} alt="" loading="lazy" onError={() => setFailed(true)} className="h-1/2 w-1/2 object-contain" />
      ) : (
        <span className="font-bold text-zinc-400" style={{ fontSize: size * 0.42 }}>
          {(s.name || s.slug).charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}

const CHIP = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap';

/** What the card says about this service at a glance. One chip, never two. */
function StateChip({ s }: { s: Service }) {
  const live = s.accounts.filter(isLive).length;
  const pending = s.accounts.filter(isPending).length;
  const broken = s.accounts.length - live - pending;
  if (live) {
    return (
      <span className={CHIP + ' bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'}>
        <Check size={11} /> {live > 1 ? `${live} accounts` : 'Connected'}
      </span>
    );
  }
  if (pending) return <span className={CHIP + ' bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'}><Loader2 size={11} className="animate-spin" /> Finishing</span>;
  if (broken) return <span className={CHIP + ' bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'}><AlertTriangle size={11} /> Reconnect</span>;
  if (s.noAuth) return <span className={CHIP + ' bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'}><Zap size={11} /> Ready to use</span>;
  if (!s.managedAuth) return <span className={CHIP + ' bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}><KeyRound size={11} /> Your own key</span>;
  return null;
}

// ---- the page ---------------------------------------------------------------------------------

export function Tools() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useUrlState('service'); // in the URL so Back closes the panel (BEA-1001)
  const toast = useToast();

  const load = useCallback(async (refresh = false) => {
    try {
      const r = await fetch('/api/tools/services' + (refresh ? '?refresh=1' : ''));
      if (!r.ok) throw new Error('failed');
      setData(await r.json());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Stable on purpose: the panel watches for a sign-in to finish on a timer, and a fresh callback
  // on every render of this page would tear that timer down and start it again for ever.
  const changed = useCallback((msg?: string) => { if (msg) toast('success', msg); load(true); }, [load, toast]);

  const services = data?.services || [];
  const connected = useMemo(() => services.filter((s) => s.accounts.length > 0), [services]);

  const rows: Row[] = useMemo(
    () =>
      services.map((s) => ({
        ...s,
        // Search reaches every one of the 1,209 by name, slug, description AND category — the point
        // of the box is that the owner types "invoice" and finds a service they never knew existed.
        _search: [s.name, s.slug, s.description, s.category, ...(s.categories || [])].filter(Boolean).join(' '),
        _actions: num(s.actionCount),
        _triggers: num(s.triggerCount),
        _signin: signInKind(s),
        _state: s.accounts.length ? (s.accounts.some(isLive) ? 'connected' : 'attention') : 'no',
      })),
    [services],
  );

  const columns: Column<Row>[] = useMemo(() => [{ key: '_search', label: 'Service' }], []);

  const filters: Filter[] = useMemo(
    () => [
      {
        key: 'category',
        label: 'Category',
        // Built from the services themselves, biggest first, so no choice can come back empty.
        options: (data?.categories || []).map((c) => ({ value: c.id, label: `${c.label} (${c.count})` })),
        match: (r: Row, v: string) => (r.categories || []).includes(v),
      },
      {
        key: '_state',
        label: 'Status',
        options: [
          { value: 'connected', label: 'Connected' },
          { value: 'attention', label: 'Needs attention' },
          { value: 'no', label: 'Not connected' },
        ],
      },
      {
        key: '_signin',
        label: 'Sign-in',
        options: [
          { value: 'oneclick', label: 'One click' },
          { value: 'own', label: 'Your own key' },
          { value: 'none', label: 'None needed' },
        ],
      },
    ],
    [data?.categories],
  );

  const sortOptions: SortOption[] = [
    { label: 'Most actions', key: '_actions', dir: -1 },
    { label: 'Name A–Z', key: 'name', dir: 1 },
    { label: 'Most events', key: '_triggers', dir: -1 },
  ];

  const status = data?.status;
  const showBrowse = !loading && !failed && status?.configured && status?.reachable;

  return (
    // The bottom padding is not decoration: the floating chat button is pinned to the same corner
    // as the pager, and without it "Next" sits underneath the button on the last screenful.
    <div className="space-y-5 pb-16">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><Cable className="text-emerald-500" /> Tools</h1>
          <p className="text-zinc-500 text-sm">
            Sign in to the services you already use, once. Your agents can then work in them for you.
          </p>
        </div>
        {showBrowse && (
          <button
            onClick={() => { setLoading(true); load(true); }}
            title="Check again"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <RefreshCw size={15} /> <span className="hidden sm:inline">Check again</span>
          </button>
        )}
      </header>

      {loading && <LoadingState />}

      {/* Something between us and the page itself broke — not the same thing as the key being wrong. */}
      {!loading && failed && (
        <Notice
          tone="warn"
          icon={<AlertTriangle size={20} />}
          title="We could not load your tools"
          body="Something went wrong on the way to the server. Your connections are safe — nothing has changed."
          action={<button onClick={() => { setLoading(true); load(true); }} className={PRIMARY_BTN}><RefreshCw size={15} /> Try again</button>}
        />
      )}

      {/* No key. The one state that is not an error — there is simply nothing set up yet. */}
      {!loading && !failed && status && !status.configured && (
        <Notice
          icon={<Plug size={20} />}
          title="No key yet"
          body="Tools connect through one key that you add once in Settings. Once it is in, every service you already use turns up here, ready to sign in to."
          action={<Link to="/settings/connections" className={PRIMARY_BTN}>Add the key in Settings <ArrowRight size={15} /></Link>}
        />
      )}

      {/* Key set, but nobody is answering — a wrong key, an outage, a slow network. Say which. */}
      {!loading && !failed && status && status.configured && !status.reachable && (
        <Notice
          tone="warn"
          icon={<AlertTriangle size={20} />}
          title="We cannot reach the tools service"
          body={(status.message || 'It did not answer.') + ' Your connected services keep working — this page just cannot list them right now.'}
          action={
            <>
              <button onClick={() => { setLoading(true); load(true); }} className={PRIMARY_BTN}><RefreshCw size={15} /> Try again</button>
              <Link to="/settings/connections" className={GHOST_BTN}>Check the key</Link>
            </>
          }
        />
      )}

      {showBrowse && (
        <>
          {connected.length > 0 ? (
            <section>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-500">
                <PlugZap size={15} className="text-emerald-500" /> Your connections
                <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-500 dark:bg-zinc-800">{connected.length}</span>
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {connected.map((s) => <ServiceCard key={s.slug} s={s} onOpen={() => setOpen(s.slug)} />)}
              </div>
            </section>
          ) : (
            <Notice
              icon={<Search size={20} />}
              title="Nothing connected yet"
              body={`Your key works — ${plural(services.length, 'service')} are ready to browse below. Pick one and sign in; it takes a few seconds.`}
            />
          )}

          <section>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-500">
              <Search size={15} /> All services
            </h2>
            <DataTable<Row>
              columns={columns}
              rows={rows}
              filters={filters}
              sortOptions={sortOptions}
              defaultSort={{ key: '_actions', dir: -1 }}
              renderCard={(s) => <ServiceCard s={s} onOpen={() => setOpen(s.slug)} />}
              cardsOnly
              gridClassName="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
              pageSize={24}
              emptyText="No service matches that. Try a shorter word, or clear the filters."
            />
          </section>
        </>
      )}

      {/* Keyed by the slug so a jump straight from one service to another (a hand-edited `?service=`)
          starts the panel fresh, instead of carrying the last one's half-filled form into it. */}
      {open && <ServiceSheet key={open} slug={open} onClose={() => setOpen('')} onChanged={changed} />}
    </div>
  );
}

const PRIMARY_BTN = 'inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50';
const GHOST_BTN = 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3.5 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50';

/** One calm box for every "there is nothing to show, and here is why" moment on this page. */
function Notice({ icon, title, body, action, tone = 'plain' }: { icon: ReactNode; title: string; body: string; action?: ReactNode; tone?: 'plain' | 'warn' }) {
  const warn = tone === 'warn';
  return (
    <div className={'rounded-xl border p-5 sm:p-6 ' + (warn ? 'border-amber-300/60 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5' : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900')}>
      <div className="flex flex-col items-start gap-3 sm:flex-row">
        <div className={'shrink-0 rounded-lg p-2 ' + (warn ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-emerald-500/10 text-emerald-600')}>{icon}</div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{body}</p>
          {action && <div className="mt-3 flex flex-wrap gap-2">{action}</div>}
        </div>
      </div>
    </div>
  );
}

/** Shimmering stand-ins in the real card shape — never a bare spinner or a blank screen. */
function LoadingState() {
  return (
    <div className="space-y-4" data-testid="tools-loading">
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-full sm:w-64" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-start gap-3">
              <Skeleton className="h-10 w-10 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
            <Skeleton className="mt-4 h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-4/5" />
            <Skeleton className="mt-4 h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ServiceCard({ s, onOpen }: { s: Service; onOpen: () => void }) {
  const live = s.accounts.filter(isLive).length;
  const needsAttention = s.accounts.length - live - s.accounts.filter(isPending).length;
  const cta = s.accounts.length ? 'Manage' : s.noAuth ? 'View' : s.managedAuth ? 'Connect' : 'Set up';
  return (
    <button
      onClick={onOpen}
      className="group h-full w-full min-w-0 rounded-xl border border-zinc-200 bg-white p-4 text-left transition-all hover:border-emerald-500/40 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 flex flex-col"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Logo s={s} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold leading-snug group-hover:text-emerald-600">{s.name}</h3>
          <p className="mt-0.5 truncate text-xs text-zinc-400">{s.category}</p>
        </div>
        <span className="shrink-0"><StateChip s={s} /></span>
      </div>

      <p className="mt-3 line-clamp-2 break-words text-sm text-zinc-500 dark:text-zinc-400">
        {s.description || 'No description.'}
      </p>

      <div className="mt-auto flex items-end justify-between gap-2 pt-3 text-xs">
        <span className="min-w-0 truncate text-zinc-400">
          {plural(num(s.actionCount), 'action')}
          {num(s.triggerCount) > 0 && ` · ${plural(num(s.triggerCount), 'event')}`}
          {needsAttention > 0 && <span className="text-amber-600 dark:text-amber-400"> · {needsAttention} to fix</span>}
        </span>
        <span className="shrink-0 font-medium text-emerald-600 group-hover:underline">{cta}</span>
      </div>
    </button>
  );
}

// ---- one service ------------------------------------------------------------------------------

/** How long we keep watching for a sign-in to finish before saying so. The link itself lasts ~12 min. */
const WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 3000;

function ServiceSheet({ slug, onClose, onChanged }: { slug: string; onClose: () => void; onChanged: (msg?: string) => void }) {
  const [svc, setSvc] = useState<FullService | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ fields: CredField[]; values: Record<string, string> } | null>(null);
  const [waiting, setWaiting] = useState<{ since: number; url?: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<Account | null>(null);
  const [error, setError] = useState('');
  const toast = useToast();
  const closeRef = useRef<() => void>(() => undefined);

  const load = useCallback(async (refresh = false) => {
    try {
      const r = await fetch(`/api/tools/services/${encodeURIComponent(slug)}${refresh ? '?refresh=1' : ''}`);
      const d = await r.json().catch(() => ({}));
      if (!d?.service) { setError(d?.message || 'We could not load that service.'); return null; }
      setSvc(d.service);
      setError('');
      return d.service as FullService;
    } catch {
      setError('We could not reach the server.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  /**
   * While the owner is signing in on the provider's own page, watch for the account to go live.
   *
   * A poll rather than a callback because the sign-in happens in another tab: the page is never
   * navigated away from, so there is no callback to catch — and the card must not sit on
   * "connecting" for ever if the owner closes that tab or the twelve-minute link expires.
   */
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const fresh = await load(true);
      if (stop) return;
      if (fresh?.accounts?.some(isLive)) {
        setWaiting(null);
        onChanged(`${fresh.name} is connected.`);
        return;
      }
      if (Date.now() - waiting.since > WAIT_MS) {
        setWaiting(null);
        setError('That sign-in did not finish — the link only lasts a few minutes. Start it again when you are ready.');
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    let timer = setTimeout(tick, POLL_MS);
    // Coming back to this tab almost always means the sign-in just finished — check straight away.
    const onFocus = () => { clearTimeout(timer); timer = setTimeout(tick, 300); };
    window.addEventListener('focus', onFocus);
    return () => { stop = true; clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [waiting, load, onChanged]);

  async function startConnect(credentials?: Record<string, string>) {
    setBusy(true);
    setError('');
    // Opened on the click itself, before any awaiting: a tab opened after a network round trip is
    // what pop-up blockers exist to stop. If it is blocked anyway we show the link instead.
    //
    // NO feature string. Checked in a real browser: passing either `noopener` OR `noreferrer` makes
    // window.open return **null** by spec, which would leave a blank tab stranded and push every
    // one-click sign-in down the "your browser blocked it" path. The blank tab starts on our own
    // origin, so severing `opener` here does the same job before it goes anywhere near the provider.
    let tab: Window | null = null;
    if (!credentials) {
      tab = window.open('', '_blank');
      try { if (tab) tab.opener = null; } catch { /* already severed, or the tab was blocked */ }
    }
    try {
      const r = await fetch(`/api/tools/services/${encodeURIComponent(slug)}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials }),
      });
      const d = await r.json().catch(() => ({}));

      if (d?.needsCredentials) {
        tab?.close();
        setForm({ fields: d.fields || [], values: {} });
        return;
      }
      if (!d?.ok) {
        tab?.close();
        setError(d?.message || 'That did not work. Try again in a moment.');
        return;
      }
      if (d.redirectUrl) {
        if (tab) tab.location.href = d.redirectUrl;
        setWaiting({ since: Date.now(), url: tab ? undefined : d.redirectUrl });
        setForm(null);
        return;
      }
      // Nothing to sign into, or a key that worked on the spot — it is already done.
      tab?.close();
      setForm(null);
      await load(true);
      onChanged(d.message || 'Connected.');
    } catch {
      tab?.close();
      setError('We could not reach the server. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  async function saveLabel() {
    if (!renaming) return;
    const { id, value } = renaming;
    setRenaming(null);
    const r = await fetch(`/api/tools/services/connections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: value }),
    }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    if (!d?.ok) { toast('error', d?.message || 'Could not rename that account.'); return; }
    await load(true);
    onChanged();
  }

  async function doDisconnect() {
    const a = confirm;
    if (!a) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/tools/services/connections/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!d?.ok) { toast('error', d?.message || 'Could not disconnect that account.'); return; }
      setConfirm(null);
      const fresh = await load(true);
      onChanged(`${a.label} disconnected.`);
      if (!fresh?.accounts?.length) closeRef.current();
    } finally {
      setBusy(false);
    }
  }

  const accounts = svc?.accounts || [];
  const fields = form?.fields || [];
  const missing = fields.filter((f) => f.required !== false && !String(form?.values?.[f.name] || '').trim());
  const inputCls = 'w-full rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950';

  return (
    <>
      <Sheet onClose={onClose} size="lg">
        {(close) => {
          closeRef.current = close;
          return (
            <div className="min-w-0">
              <div className="mb-4 flex min-w-0 items-start gap-3">
                {svc ? <Logo s={svc} size={44} /> : <Skeleton className="h-11 w-11 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-lg font-bold">{svc?.name || slug}</h3>
                  <p className="mt-0.5 truncate text-xs text-zinc-400">
                    {svc ? `${svc.category} · ${plural(num(svc.actionCount), 'action')}${num(svc.triggerCount) ? ` · ${plural(num(svc.triggerCount), 'event')}` : ''}` : 'Loading…'}
                  </p>
                </div>
                <button onClick={close} aria-label="Close" className="shrink-0 rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
                  <X size={18} />
                </button>
              </div>

              {loading && <div className="space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-9 w-40" /></div>}

              {!loading && svc?.description && <p className="mb-4 break-words text-sm text-zinc-500 dark:text-zinc-400">{svc.description}</p>}

              {error && (
                <p className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/5 dark:text-amber-300">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" /> <span className="min-w-0">{error}</span>
                </p>
              )}

              {/* The accounts. Several of one service is the whole point — two inboxes, two orgs. */}
              {accounts.length > 0 && (
                <div className="mb-4">
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    {accounts.length === 1 ? 'Account' : `${accounts.length} accounts`}
                  </h4>
                  <ul className="space-y-2">
                    {accounts.map((a) => (
                      <li key={a.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
                        <span className={'mt-0.5 h-2 w-2 shrink-0 rounded-full ' + (isLive(a) ? 'bg-emerald-500' : isPending(a) ? 'bg-amber-400' : 'bg-red-400')} />
                        <div className="min-w-0 flex-1">
                          {renaming?.id === a.id ? (
                            <input
                              autoFocus
                              value={renaming.value}
                              onChange={(e) => setRenaming({ id: a.id, value: e.target.value })}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveLabel(); if (e.key === 'Escape') setRenaming(null); }}
                              onBlur={saveLabel}
                              aria-label="Account name"
                              className={inputCls + ' py-1'}
                            />
                          ) : (
                            <p className="truncate text-sm font-medium">{a.label}</p>
                          )}
                          <p className="truncate text-xs text-zinc-400">
                            {statusWords(a.status)}
                            {a.connectedAt && ` · added ${when(a.connectedAt)}`}
                            {a.lastUsedAt && ` · last used ${when(a.lastUsedAt)}`}
                          </p>
                        </div>
                        {!isLive(a) && !isPending(a) && (
                          <button onClick={() => startConnect()} disabled={busy} className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50">
                            Reconnect
                          </button>
                        )}
                        {renaming?.id !== a.id && (
                          <button onClick={() => setRenaming({ id: a.id, value: a.label })} title="Rename" aria-label={`Rename ${a.label}`} className="shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800">
                            <Pencil size={14} />
                          </button>
                        )}
                        <button onClick={() => setConfirm(a)} title="Disconnect" aria-label={`Disconnect ${a.label}`} className="shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-red-500/10 hover:text-red-600">
                          <Trash2 size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Waiting on the provider's own sign-in page, in the other tab. */}
              {waiting && (
                <div className="mb-4 rounded-lg border border-emerald-300/60 bg-emerald-50/60 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/5">
                  <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                    <Loader2 size={15} className="shrink-0 animate-spin" /> Waiting for you to finish signing in…
                  </p>
                  <p className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-300/80">
                    {waiting.url ? 'Open the sign-in page to finish — this page will notice when you are done.' : 'Finish in the tab that opened, then come back. This page will notice on its own.'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {waiting.url && (
                      <a href={waiting.url} target="_blank" rel="noreferrer" className={PRIMARY_BTN}>
                        Open the sign-in page <ExternalLink size={14} />
                      </a>
                    )}
                    <button onClick={() => setWaiting(null)} className={GHOST_BTN}>Stop waiting</button>
                  </div>
                </div>
              )}

              {/* Bring your own key. The common case, so it gets a real form. */}
              {form && !waiting && (
                <div className="mb-4 space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    {svc?.name} has no ready-made sign-in, so it needs {fields.length === 1 ? 'one detail' : `${fields.length} details`} from your own account with them.
                  </p>
                  {fields.map((f) => (
                    <label key={f.name} className="block text-xs text-zinc-500">
                      {f.label}{f.required === false && <span className="text-zinc-400"> (optional)</span>}
                      <input
                        type={f.secret ? 'password' : 'text'}
                        autoComplete="off"
                        value={form.values[f.name] || ''}
                        onChange={(e) => setForm({ fields, values: { ...form.values, [f.name]: e.target.value } })}
                        className={inputCls + ' mt-1'}
                      />
                      {f.description && <span className="mt-1 block break-words text-[11px] text-zinc-400">{f.description}</span>}
                    </label>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => startConnect(form.values)} disabled={busy || missing.length > 0} className={PRIMARY_BTN}>
                      {busy ? <><Loader2 size={15} className="animate-spin" /> Connecting…</> : <>Connect</>}
                    </button>
                    <button onClick={() => setForm(null)} disabled={busy} className={GHOST_BTN}>Cancel</button>
                  </div>
                </div>
              )}

              {/* What you can do next. */}
              {!loading && svc && !form && !waiting && (
                <div className="space-y-2">
                  {/* Said BEFORE the button, not after it fails: most services have no ready-made
                      sign-in, and being told what you need up front is the difference between a
                      two-minute detour and a dead end. */}
                  {!svc.noAuth && !svc.managedAuth && (svc.needs || []).length > 0 && (
                    <p className="flex items-start gap-2 rounded-lg border border-zinc-200 p-3 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                      <KeyRound size={15} className="mt-0.5 shrink-0 text-zinc-400" />
                      <span className="min-w-0">
                        This one has no ready-made sign-in. You will need your own{' '}
                        <b className="font-medium text-zinc-700 dark:text-zinc-200">{(svc.needs || []).map((f) => f.label.toLowerCase()).join(', ')}</b> from {svc.name}.
                      </span>
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                  {svc.noAuth ? (
                    <p className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                      <Zap size={15} className="shrink-0 text-sky-500" /> No sign-in needed — your agents can use this one already.
                    </p>
                  ) : (
                    <button onClick={() => startConnect()} disabled={busy} className={PRIMARY_BTN}>
                      {busy ? <Loader2 size={15} className="animate-spin" /> : <Plug size={15} />}
                      {accounts.length ? 'Add another account' : svc.managedAuth ? 'Connect' : 'Set up with your own key'}
                    </button>
                  )}
                  {accounts.length > 0 && (
                    <span className="text-xs text-zinc-400">Adding another keeps the ones you have.</span>
                  )}
                  </div>
                </div>
              )}
            </div>
          );
        }}
      </Sheet>

      <ConfirmDialog
        open={!!confirm}
        title="Disconnect this account?"
        message={confirm ? `“${confirm.label}” will be signed out of ${svc?.name || slug}. Any agent using it will stop being able to. You can connect it again whenever you like.` : ''}
        confirmLabel="Disconnect"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={doDisconnect}
      />
    </>
  );
}

export default Tools;
