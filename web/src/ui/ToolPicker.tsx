import { useEffect, useMemo, useState } from 'react';
import { Check, Search, X, Plug, Loader2, Wrench } from 'lucide-react';
import { Sheet } from './Sheet';
import { ServiceFolds, RetiredTag, matchesWords } from './ServiceFolds';

/**
 * The one tool picker (BEA-1167). Reads the single catalog so the agent toolbox, the builder chat's
 * tool step and the flow canvas can never offer different things.
 *
 * Deliberately a plain tick list: you are choosing what an agent is ALLOWED to touch, so seeing
 * everything available — including what you have not connected yet — matters more than brevity.
 */

export type CatalogTool = {
  id: string;
  name: string;
  group: string;
  description: string;
  kind: 'tool' | 'skill' | 'mcp';
  connected: boolean;
  connectHint?: string;
  connectPath?: string;
  /** Services / Social entries only — which outside service the action belongs to. */
  service?: string;
  /** Services / Social entries only — the vendor retired it; still offered, tagged (BEA-1365). */
  retired?: boolean;
};

/**
 * The groups that hold every action of every connected service (BEA-1354 — GitHub alone ~800).
 * They are drawn folded per service with search-within-service and paging, never as one flat list.
 */
const FOLDED_GROUPS = new Set(['Services', 'Social']);

type Catalog = { groups: { group: string; tools: CatalogTool[] }[]; tools: CatalogTool[] };

/** Loaded once per page — the catalog probes Google and the engine host, so don't refetch per picker. */
let cache: Catalog | null = null;
let inflight: Promise<Catalog | null> | null = null;

export function loadCatalog(force = false): Promise<Catalog | null> {
  if (cache && !force) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch('/api/tools/catalog')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Catalog | null) => { if (d?.tools) cache = d; return cache; })
      .catch(() => null)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Look up display info for already-picked ids (chips elsewhere in the app). */
export function useCatalog() {
  const [cat, setCat] = useState<Catalog | null>(cache);
  useEffect(() => { let live = true; loadCatalog().then((c) => { if (live) setCat(c); }); return () => { live = false; }; }, []);
  return cat;
}

export function ToolPicker({
  value,
  onSave,
  onClose,
  title = 'Tools',
  subtitle = 'Pick what this agent is allowed to use.',
}: {
  value: string[];
  onSave: (ids: string[], picked: CatalogTool[]) => void;
  onClose: () => void;
  title?: string;
  subtitle?: string;
}) {
  const [cat, setCat] = useState<Catalog | null>(cache);
  const [loading, setLoading] = useState(!cache);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>(value || []);

  useEffect(() => {
    let live = true;
    loadCatalog().then((c) => {
      if (!live) return;
      setCat(c); setLoading(false); setFailed(!c);
    });
    return () => { live = false; };
  }, []);

  const groups = useMemo(() => {
    if (!cat) return [];
    const needle = q.trim().toLowerCase();
    const hit = (t: CatalogTool) => !needle || (t.name + ' ' + t.description).toLowerCase().includes(needle);
    const hitWords = (t: CatalogTool) => !needle || matchesWords(`${t.name} ${t.description} ${t.id}`, needle);
    return cat.groups
      // A folded group keeps its whole list (the folds do their own narrowing) — it just has to have
      // at least one match to be shown at all.
      .map((g) => (FOLDED_GROUPS.has(g.group) ? { ...g, tools: g.tools.some(hitWords) ? g.tools : [] } : { ...g, tools: g.tools.filter(hit) }))
      .filter((g) => g.tools.length > 0);
  }, [cat, q]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  /** One tick row — the same drawing inside a service fold and in a plain group. */
  const row = (t: CatalogTool, label: string) => {
    const on = picked.includes(t.id);
    return (
      <button
        key={t.id}
        onClick={() => toggle(t.id)}
        className={
          'flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition-colors ' +
          (on ? 'bg-emerald-50 dark:bg-emerald-500/10' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800')
        }
      >
        <span
          aria-hidden
          className={
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ' +
            (on ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-zinc-300 dark:border-zinc-600')
          }
        >
          {on && <Check className="h-3 w-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={'text-sm font-medium ' + (t.connected ? '' : 'text-zinc-500')}>{label}</span>
            {t.retired && <RetiredTag />}
            {!t.connected && (
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">needs connecting</span>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-zinc-500">{t.description}</span>
          {!t.connected && t.connectHint && (
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
              <Plug className="h-3 w-3" />
              {t.connectHint}
              {t.connectPath && <a href={t.connectPath} onClick={(e) => e.stopPropagation()} className="underline hover:no-underline">open</a>}
            </span>
          )}
        </span>
      </button>
    );
  };
  const save = (close: () => void) => {
    const all = cat?.tools || [];
    onSave(picked, picked.map((id) => all.find((t) => t.id === id)).filter(Boolean) as CatalogTool[]);
    close();
  };

  return (
    <Sheet onClose={onClose} size="lg">
      {(close) => (
        <div className="flex max-h-[86vh] flex-col">
          <div className="flex items-start justify-between gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Wrench className="h-4 w-4 text-zinc-400" />{title}</h2>
              <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
            </div>
            <button onClick={close} aria-label="Close" className="shrink-0 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"><X className="h-5 w-5" /></button>
          </div>

          <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2 dark:border-zinc-800">
            <Search className="h-4 w-4 shrink-0 text-zinc-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search tools, skills and servers…"
              className="min-w-0 flex-1 bg-transparent py-1 text-base outline-none sm:text-sm"
            />
            {q && <button onClick={() => setQ('')} className="shrink-0 text-xs text-zinc-400 hover:text-zinc-600">clear</button>}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {loading && (
              <div className="space-y-2 p-2">
                {[0, 1, 2, 3].map((i) => <div key={i} className="h-11 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}
              </div>
            )}

            {!loading && failed && (
              <div className="p-6 text-center text-sm text-zinc-500">
                Couldn't load the tool list.
                <button onClick={() => { setLoading(true); setFailed(false); loadCatalog(true).then((c) => { setCat(c); setLoading(false); setFailed(!c); }); }} className="ml-1 text-emerald-600 hover:underline">Try again</button>
              </div>
            )}

            {!loading && !failed && groups.length === 0 && (
              <div className="p-8 text-center text-sm text-zinc-400">Nothing matches “{q}”.</div>
            )}

            {groups.map((g) => (
              <div key={g.group} className="mb-3">
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  {g.group}
                  {FOLDED_GROUPS.has(g.group) && <span className="ml-1.5 normal-case tracking-normal text-zinc-400">· {g.tools.length.toLocaleString()} actions</span>}
                </div>
                {FOLDED_GROUPS.has(g.group) ? (
                  <ServiceFolds items={g.tools} query={q} pickedIds={picked} renderItem={(t, label) => row(t, label)} />
                ) : (
                  <div className="space-y-0.5">{g.tools.map((t) => row(t, t.name))}</div>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <span className="text-xs text-zinc-500">{picked.length} picked</span>
            <div className="flex gap-2">
              <button onClick={close} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Cancel</button>
              <button onClick={() => save(close)} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Save
              </button>
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}
