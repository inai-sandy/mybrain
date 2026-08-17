import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Bell, Check, Cable, Clock, ExternalLink, History, KeyRound, Loader2, Pencil, Plug, PlugZap, RefreshCw, Search, Trash2, X, Zap,
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
  /** Connected services only — the actions the owner's agents can really pick (BEA-1354: all of them). */
  availableActionCount?: number;
  triggerCount?: number;
  managedAuth?: boolean;
  noAuth?: boolean;
  connected: boolean;
  accounts: Account[];
  needsCount: number;
};
type CredField = { name: string; label: string; description?: string; required?: boolean; secret?: boolean };
/** One action that cannot be undone, and whether the owner has let it run without asking (BEA-1348). */
type Gate = { id: string; name: string; description?: string; released: boolean };
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

/**
 * The gates (BEA-1348) — the actions of this service that stop and ask before they run.
 *
 * Shown only once a service is connected, because it is only then that anything can run. The list
 * is short by design: normal writes never appear here, only the handful that cannot be taken back.
 * Releasing one is per SERVICE, not per agent — there is one answer to "does this ask me?".
 */
function Gates({ slug, name }: { slug: string; name: string }) {
  const [gates, setGates] = useState<Gate[] | null>(null);
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    fetch(`/api/tools/services/${encodeURIComponent(slug)}/gates`)
      .then((r) => r.json())
      .then((d) => { if (alive) setGates(Array.isArray(d?.actions) ? d.actions : []); })
      .catch(() => { if (alive) setGates([]); });
    return () => { alive = false; };
  }, [slug]);

  async function set(g: Gate, released: boolean) {
    setBusy(g.id);
    try {
      const r = await fetch(`/api/tools/services/${encodeURIComponent(slug)}/gates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: g.id, released }),
      });
      const d = await r.json().catch(() => ({}));
      if (!d?.ok) { toast('error', d?.message || 'That did not work. Try again in a moment.'); return; }
      setGates((list) => (list || []).map((x) => (x.id === g.id ? { ...x, released } : x)));
      toast('success', released ? `“${g.name}” will now run without asking.` : `“${g.name}” will stop and ask again.`);
    } catch {
      toast('error', 'We could not reach the server. Try again in a moment.');
    } finally {
      setBusy('');
    }
  }

  if (gates === null) return <div className="mb-4"><Skeleton className="h-4 w-48" /></div>;
  if (!gates.length) return null;
  const shown = q.trim() ? gates.filter((g) => g.name.toLowerCase().includes(q.trim().toLowerCase())) : gates;

  return (
    <div className="mb-4">
      <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <AlertTriangle size={12} /> Stops and asks first · {gates.length}
      </h4>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
        These {name} actions cannot be undone, so a run pauses and asks you before doing one. Everything else — new issues,
        comments, messages, edits — just runs. Release one and it will never ask about it again.
      </p>
      {gates.length > 8 && (
        <div className="relative mb-2">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search these actions"
            aria-label="Search the actions that stop and ask"
            className="w-full rounded-lg border border-zinc-300 bg-zinc-100 py-1.5 pl-8 pr-3 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
      )}
      <ul className="max-h-64 space-y-1.5 overflow-y-auto">
        {shown.map((g) => (
          <li key={g.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{g.name}</p>
              <p className="truncate text-[11px] text-zinc-400">{g.released ? 'Runs without asking' : 'Asks you first'}</p>
            </div>
            <button
              onClick={() => set(g, !g.released)}
              disabled={busy === g.id}
              className={'shrink-0 rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50 ' + (g.released ? 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800' : 'text-amber-600 hover:bg-amber-500/10')}
            >
              {busy === g.id ? <Loader2 size={13} className="animate-spin" /> : g.released ? 'Ask me again' : 'Release'}
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-1 py-2 text-xs text-zinc-400">Nothing matches “{q}”.</li>}
      </ul>
    </div>
  );
}

// ---- triggers: when this happens, run that (BEA-1350) -----------------------------------------

/** One kind of event a service can tell us about. `instant`/`everyMinutes` are read live, never guessed. */
type TriggerOption = { id: string; name: string; description?: string; instant?: boolean; everyMinutes?: number; config?: any };
/** One of the owner's rules. */
type Binding = {
  id: string; service: string; triggerType: string; eventName: string; listening: boolean;
  flowId: string; flowName?: string | null; config?: Record<string, any>; label?: string | null;
  enabled: boolean; rateCap: number; lastFiredAt?: string | null; pausedReason?: string | null; ranLastHour?: number;
};
/** One thing that arrived, and what we did with it. */
type TriggerEvent = { id: string; status: string; detail?: string; runId?: string | null; summary?: string; at: string };
type FlowRow = { id: string; name: string };

/**
 * How often it is checked, in the owner's words.
 *
 * This is the sentence the issue asks for out loud: some events are pushed the moment they happen
 * and some are looked up on a timer, and a rule built on the second kind is a different promise.
 * Both facts come from the provider at run time — 108 of the 362 live event types are instant and
 * 254 are polled, and each polled one carries its own interval.
 */
function howOften(t: { instant?: boolean; everyMinutes?: number }): string {
  if (t?.instant) return 'As it happens';
  const n = Number(t?.everyMinutes);
  if (!Number.isFinite(n) || n <= 0) return 'Checked on a timer';
  return `Checked every ${n === 1 ? 'minute' : `${n} minutes`}`;
}

/** The event's own settings, minus the one that is ours to read rather than his to fill in. */
function configFields(t: TriggerOption | null): { name: string; label: string; description?: string; required: boolean }[] {
  const props = (t?.config?.properties || {}) as Record<string, any>;
  const required: string[] = Array.isArray(t?.config?.required) ? t!.config.required : [];
  return Object.keys(props)
    .filter((k) => k !== 'interval')
    .map((k) => ({ name: k, label: props[k]?.title || k, description: props[k]?.description, required: required.includes(k) }))
    .sort((a, b) => Number(b.required) - Number(a.required) || a.label.localeCompare(b.label));
}

const EVENT_WORDS: Record<string, { label: string; cls: string }> = {
  ran: { label: 'Started the flow', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  busy: { label: 'Joined a run already going', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' },
  echo: { label: 'We caused it — dropped', cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400' },
  capped: { label: 'Over the limit', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  failed: { label: 'Could not start', cls: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300' },
  ignored: { label: 'Nothing to do', cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400' },
};

function whenText(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * The rules for one service: when this happens there, run that flow here.
 *
 * Shown only once a service is connected, because nothing can listen before that. Two facts shape
 * the whole panel: **a connected service may offer no events at all** (Sentry and Vercel offer
 * none), so it says so in a sentence instead of drawing an empty picker; and every event says
 * plainly whether it is instant or looked up on a timer, because that changes what a rule is worth.
 */
function Triggers({ slug, name, triggerCount }: { slug: string; name: string; triggerCount: number }) {
  const [bindings, setBindings] = useState<Binding[] | null>(null);
  const [options, setOptions] = useState<TriggerOption[] | null>(null);
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<Binding | null>(null);
  const [openHistory, setOpenHistory] = useState('');
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/tools/triggers?service=${encodeURIComponent(slug)}`);
      const d = await r.json().catch(() => ({}));
      setBindings(Array.isArray(d?.bindings) ? d.bindings : []);
    } catch {
      setBindings([]);
    }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  /** The events and the flows are only fetched when he actually goes to make a rule. */
  async function openForm() {
    setAdding(true);
    if (options) return;
    setLoadingOptions(true);
    try {
      const [t, f] = await Promise.all([
        fetch(`/api/tools/triggers/available/${encodeURIComponent(slug)}`).then((r) => r.json()).catch(() => ({})),
        fetch('/api/flows').then((r) => r.json()).catch(() => ({})),
      ]);
      setOptions(Array.isArray(t?.triggers) ? t.triggers : []);
      setFlows(Array.isArray(f?.flows) ? f.flows.map((x: any) => ({ id: x.id, name: x.name })) : []);
    } finally {
      setLoadingOptions(false);
    }
  }

  async function save(body: any) {
    setBusy('new');
    try {
      const r = await fetch('/api/tools/triggers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: slug, ...body }) });
      const d = await r.json().catch(() => ({}));
      if (!d?.ok) { toast('error', d?.message || 'That did not work. Try again in a moment.'); return; }
      setAdding(false);
      await load();
      toast('success', `${name} will now start that flow when this happens.`);
    } catch {
      toast('error', 'We could not reach the server. Try again in a moment.');
    } finally {
      setBusy('');
    }
  }

  async function patch(b: Binding, body: any, said: string) {
    setBusy(b.id);
    try {
      const r = await fetch(`/api/tools/triggers/${encodeURIComponent(b.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!d?.ok) { toast('error', d?.message || 'That did not work. Try again in a moment.'); return; }
      await load();
      toast('success', said);
    } catch {
      toast('error', 'We could not reach the server. Try again in a moment.');
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    const b = confirm;
    if (!b) return;
    setBusy(b.id);
    try {
      const r = await fetch(`/api/tools/triggers/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!d?.ok) { toast('error', d?.message || 'We could not remove that rule.'); return; }
      setConfirm(null);
      await load();
      toast('success', 'That rule is gone, and the service will stop sending it.');
    } finally {
      setBusy('');
    }
  }

  if (bindings === null) return <div className="mb-4"><Skeleton className="h-4 w-40" /></div>;

  // A connected service with nothing to listen for. Said plainly — never an empty picker.
  const nothingToListenFor = triggerCount <= 0 && !bindings.length;

  return (
    <div className="mb-4">
      <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <Bell size={12} /> When something happens{bindings.length ? ` · ${bindings.length}` : ''}
      </h4>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
        {nothingToListenFor
          ? `${name} does not offer any events, so there is nothing here to listen for. Your agents can still use it whenever they need to.`
          : `Pick something that happens in ${name} and the flow it should start. The event itself is handed to the flow to work on.`}
      </p>

      {bindings.length > 0 && (
        <ul className="space-y-2">
          {bindings.map((b) => (
            <li key={b.id} className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
              <div className="flex min-w-0 items-start gap-2">
                <span className={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + (b.enabled ? 'bg-emerald-500' : b.pausedReason ? 'bg-amber-400' : 'bg-zinc-400')} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{b.label || b.eventName}</p>
                  {/* Wraps, not truncates: on a phone the limit is the half that would be cut off,
                      and the limit is the thing that explains a quiet rule. */}
                  <p className="break-words text-xs text-zinc-400">
                    Runs <span className="text-zinc-500 dark:text-zinc-300">{b.flowName || 'a flow that is no longer there'}</span>
                    {b.lastFiredAt ? ` · last ${whenText(b.lastFiredAt)}` : ' · not yet'}
                    {` · up to ${b.rateCap}/hour`}
                  </p>
                </div>
                <button
                  onClick={() => patch(b, { enabled: !b.enabled }, b.enabled ? 'It has stopped listening.' : 'It is listening again.')}
                  disabled={busy === b.id}
                  className={'shrink-0 rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50 ' + (b.enabled ? 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800' : 'text-emerald-600 hover:bg-emerald-500/10')}
                >
                  {busy === b.id ? <Loader2 size={13} className="animate-spin" /> : b.enabled ? 'Switch off' : 'Switch on'}
                </button>
                <button onClick={() => setConfirm(b)} title="Remove this rule" aria-label={`Remove ${b.label || b.eventName}`} className="shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-red-500/10 hover:text-red-600">
                  <Trash2 size={14} />
                </button>
              </div>

              {/* It stopped itself. The reason is the whole point — never just "paused". */}
              {!b.enabled && b.pausedReason && (
                <p className="mt-2 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/5 dark:text-amber-300">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span className="min-w-0">{b.pausedReason}</span>
                </p>
              )}

              <button
                onClick={() => setOpenHistory(openHistory === b.id ? '' : b.id)}
                className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <History size={12} /> {openHistory === b.id ? 'Hide what has arrived' : 'What has arrived'}
              </button>
              {openHistory === b.id && <TriggerHistory bindingId={b.id} />}
            </li>
          ))}
        </ul>
      )}

      {!adding && !nothingToListenFor && (
        <button onClick={openForm} className={GHOST_BTN + ' mt-2 !py-1.5 !text-xs'}>
          <Bell size={13} /> {bindings.length ? 'Add another rule' : 'Add a rule'}
        </button>
      )}

      {adding && (
        <TriggerForm
          name={name}
          options={options}
          flows={flows}
          loading={loadingOptions}
          busy={busy === 'new'}
          onCancel={() => setAdding(false)}
          onSave={save}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        title="Remove this rule?"
        message={confirm ? `“${confirm.label || confirm.eventName}” will stop starting ${confirm.flowName || 'that flow'}, and ${name} will be told to stop sending it. Everything it has already done is kept.` : ''}
        confirmLabel="Remove"
        busy={!!busy}
        onCancel={() => setConfirm(null)}
        onConfirm={remove}
      />
    </div>
  );
}

/** What has arrived for one rule — including everything we deliberately did not run. */
function TriggerHistory({ bindingId }: { bindingId: string }) {
  const [rows, setRows] = useState<TriggerEvent[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/tools/triggers/${encodeURIComponent(bindingId)}/events?limit=25`)
      .then((r) => r.json())
      .then((d) => { if (alive) setRows(Array.isArray(d?.events) ? d.events : []); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [bindingId]);

  if (rows === null) return <div className="mt-2"><Skeleton className="h-3 w-32" /></div>;
  if (!rows.length) return <p className="mt-2 text-[11px] text-zinc-400">Nothing has come in yet. It will show up here the moment it does.</p>;

  return (
    <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
      {rows.map((e) => {
        const word = EVENT_WORDS[e.status] || { label: e.status, cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400' };
        return (
          <li key={e.id} className="min-w-0 rounded-md bg-zinc-50 p-2 dark:bg-zinc-800/40">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className={CHIP + ' ' + word.cls}>{word.label}</span>
              <span className="text-[11px] text-zinc-400">{whenText(e.at)}</span>
            </div>
            {e.summary && <p className="mt-1 line-clamp-2 break-words text-[11px] text-zinc-600 dark:text-zinc-300">{e.summary}</p>}
            {e.detail && <p className="mt-0.5 break-words text-[11px] text-zinc-400">{e.detail}</p>}
            {/* Straight to what it started — "it ran" is only half an answer. */}
            {e.runId && (
              <Link to={`/flows/runs/${e.runId}`} className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 hover:underline">
                See the run <ArrowRight size={11} />
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Pick the event, pick the flow, save. Everything the provider needs is asked for here, up front. */
function TriggerForm({
  name, options, flows, loading, busy, onCancel, onSave,
}: {
  name: string;
  options: TriggerOption[] | null;
  flows: FlowRow[];
  loading: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: any) => void;
}) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<TriggerOption | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [flowId, setFlowId] = useState('');
  const [label, setLabel] = useState('');
  const [cap, setCap] = useState('20');
  const [showFilters, setShowFilters] = useState(false);

  const inputCls = 'w-full rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950';
  const list = (options || []).filter((t) => !q.trim() || `${t.name} ${t.description || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const fields = configFields(picked);
  const optional = fields.filter((f) => !f.required);
  const missing = fields.filter((f) => f.required && !String(values[f.name] || '').trim());
  const ready = !!picked && !!flowId && !missing.length;

  if (loading) return <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"><Skeleton className="h-4 w-40" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-2/3" /></div>;

  // Asked for and answered: the count can only be read from the service itself, and it can be nought.
  if (options && !options.length) {
    return (
      <div className="mt-2 rounded-lg border border-zinc-200 p-3 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        {name} does not offer any events to listen for.
        <button onClick={onCancel} className="ml-2 font-medium text-emerald-600 hover:underline">Close</button>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div>
        <p className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">1. What should we watch for?</p>
        {(options || []).length > 8 && (
          <div className="relative mb-2">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${name} events`} aria-label={`Search ${name} events`} className={inputCls + ' py-1.5 pl-8'} />
          </div>
        )}
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {list.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => { setPicked(t); setValues({}); setShowFilters(false); }}
                className={'w-full min-w-0 rounded-lg border p-2 text-left transition-colors ' + (picked?.id === t.id ? 'border-emerald-500 bg-emerald-500/5' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50')}
              >
                {/* Wraps rather than truncates: on a phone the name and the chip do not fit on one
                    line, and cutting "Branch Changed" down to "Branch Cha…" hides the very thing he
                    is choosing between. The chip drops to its own line instead. */}
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 break-words text-sm font-medium">{t.name}</span>
                  {/* Said on every single row, not once in a footnote: instant and "every few
                      minutes" are different promises, and he is choosing between them here. */}
                  <span className={CHIP + ' shrink-0 ' + (t.instant ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400')}>
                    {t.instant ? <Zap size={11} /> : <Clock size={11} />} {howOften(t)}
                  </span>
                </div>
                {t.description && <p className="mt-0.5 line-clamp-2 break-words text-[11px] text-zinc-400">{t.description}</p>}
              </button>
            </li>
          ))}
          {!list.length && <li className="px-1 py-2 text-xs text-zinc-400">Nothing matches “{q}”.</li>}
        </ul>
      </div>

      {picked && fields.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">2. Where should we watch?</p>
          {/* Only what the event actually NEEDS is up front. GitHub's issue event has two required
              fields and five optional filters; showing all seven pushes "what should it start?"
              off the screen and makes a two-box job look like a form. */}
          {fields.filter((f) => f.required || showFilters).map((f) => (
            <label key={f.name} className="block text-xs text-zinc-500">
              {f.label}{!f.required && <span className="text-zinc-400"> (optional)</span>}
              <input value={values[f.name] || ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} className={inputCls + ' mt-1'} />
              {f.description && <span className="mt-1 block break-words text-[11px] text-zinc-400">{f.description}</span>}
            </label>
          ))}
          {optional.length > 0 && (
            <button onClick={() => setShowFilters(!showFilters)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              {showFilters ? 'Hide' : 'Add'} {optional.length === 1 ? 'a filter' : `filters (${optional.length})`}
            </button>
          )}
        </div>
      )}

      {picked && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{fields.length ? '3' : '2'}. What should it start?</p>
          {flows.length ? (
            <select value={flowId} onChange={(e) => setFlowId(e.target.value)} aria-label="The flow to start" className={inputCls}>
              <option value="">Pick a flow…</option>
              {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          ) : (
            <p className="rounded-lg border border-zinc-200 p-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              You have no flows yet. Build one on the Flows page first, then come back and point this at it.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <label className="min-w-0 flex-1 text-xs text-zinc-500">
              Call it
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={picked.name} className={inputCls + ' mt-1'} />
            </label>
            <label className="w-28 text-xs text-zinc-500">
              Runs an hour
              <input value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" className={inputCls + ' mt-1'} />
            </label>
          </div>
          <p className="text-[11px] text-zinc-400">
            If it starts more runs than that in an hour it stops itself and tells you, so a rule that goes wrong cannot run away.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onSave({ triggerType: picked?.id, flowId, config: values, label, rateCap: Number(cap) || 20 })}
          disabled={!ready || busy}
          className={PRIMARY_BTN}
        >
          {busy ? <><Loader2 size={15} className="animate-spin" /> Saving…</> : <>Save this rule</>}
        </button>
        <button onClick={onCancel} disabled={busy} className={GHOST_BTN}>Cancel</button>
      </div>
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
                    {svc ? `${svc.category} · ${plural(num(svc.availableActionCount ?? svc.actionCount), 'action')}${num(svc.triggerCount) ? ` · ${plural(num(svc.triggerCount), 'event')}` : ''}` : 'Loading…'}
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

              {/* What stops and asks first (BEA-1348) — only worth showing once it can actually run. */}
              {!loading && svc && (accounts.length > 0 || svc.noAuth) && <Gates slug={slug} name={svc.name} />}

              {/* And the other direction (BEA-1350): what this service can tell US about. Needs a
                  real connection — an event has to arrive on a login that exists. */}
              {!loading && svc && accounts.length > 0 && <Triggers slug={slug} name={svc.name} triggerCount={num(svc.triggerCount)} />}

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
