import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Bot, ChevronDown, ChevronUp, Coins, ExternalLink, FilePlus2, FileText, Loader2, Play, RefreshCw, Search, Share2 } from 'lucide-react';
import { Column, DataTable, SortOption } from '../ui/DataTable';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { useUrlState } from '../ui/useUrlState';
import { CHIP, CreditStrip, Endpoint, FieldInput, argsOf, GHOST_BTN, INPUT, NoKeyNotice, Notice, Platform, PlatformLogo, PRIMARY_BTN, RunResult, Spend, fieldsOf, num, plural } from './social/socialShared';
import { cell, format, heading, pickColumns, shapeOf, toMarkdown } from './social/resultShape';
import { ToolFacts } from '../ui/ToolFacts';

/**
 * `/social/:platform` — one platform, EVERY endpoint, run any of them right there (BEA-1356).
 * Design: `specs/SOCIAL.md`.
 *
 * The endpoints are the provider's list (generated from the vendor's spec — count == theirs),
 * grouped by the spec's OWN tags ("TikTok", "TikTok Shop", "TikTok Ad Library"). Opening one shows
 * a form generated from its JSON schema (required first, enums as selects) and a Run button; the
 * run goes to `POST /api/social/run`, which is the SAME `ServiceActionsService` path an agent
 * uses, so a `ToolCall` row with the real `credits` is written. The answer is drawn by its shape
 * — transcript as text, list as a table, profile as a card, anything else as JSON — with the cost
 * beside it ("cached · 0" when they charged nothing), and three things to do with it: save it as a
 * Document, send it to Capture, or make it an agent (the builder-side handoff is BEA-1357).
 *
 * The hard case is a 29-endpoint platform on a phone: every card is `min-w-0`, every long thing
 * wraps or scrolls INSIDE its own box, and the page itself never scrolls sideways.
 */

type PageData = { platform: Platform | null; actions: Endpoint[]; message?: string };

/** One row of the endpoint list, with the flat fields the table searches and sorts on. */
type Row = Endpoint & { _search: string; _tag: string; _order: number; _cost: number; _params: number };

/** Their Google-indexed searches page by number and stop at 11 (`specs/SCRAPECREATORS-API.md`). */
const PAGE_CAP = 11;

/** The cost, as a number, out of the vendor's own sentence — for "cheapest first" only. */
function costOf(hint?: string): number {
  const m = String(hint || '').match(/(\d+)\s*credits?/i);
  return m ? Number(m[1]) : 1;
}

export function SocialPlatform() {
  const { platform: slug = '' } = useParams();
  const [data, setData] = useState<PageData | null>(null);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useUrlState('q');
  const [tag, setTag] = useUrlState('tag');
  const [sortKey, setSortKey] = useUrlState('sort');
  const [open, setOpen] = useUrlState('run'); // in the URL so Back closes the panel (BEA-1001)

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([fetch(`/api/social/platforms/${encodeURIComponent(slug)}`), fetch('/api/social/spend')]);
      if (!p.ok) throw new Error('failed');
      setData(await p.json());
      if (s.ok) setSpend(await s.json());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  /** After a run: the three numbers change, the list does not. */
  const refreshSpend = useCallback(async () => {
    try {
      const r = await fetch('/api/social/spend');
      if (r.ok) setSpend(await r.json());
    } catch { /* the strip keeps its last numbers */ }
  }, []);

  const platform = data?.platform || null;
  const actions = data?.actions || [];

  /** The spec's tags in the platform's own order (biggest group first), each with its count. */
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of actions) for (const t of a.tags?.length ? a.tags : ['Other']) counts.set(t, (counts.get(t) || 0) + 1);
    const order = platform?.tags || [];
    return [...counts.entries()]
      .sort((x, y) => (order.indexOf(x[0]) === -1 ? 999 : order.indexOf(x[0])) - (order.indexOf(y[0]) === -1 ? 999 : order.indexOf(y[0])) || y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([name, count]) => ({ name, count }));
  }, [actions, platform?.tags]);

  const rows: Row[] = useMemo(
    () => actions.map((a, i) => ({
      ...a,
      _search: [a.name, a.description, a.id, a.path, ...(a.tags || []), ...Object.keys(a.schema?.properties || {})].filter(Boolean).join(' '),
      _tag: a.tags?.[0] || 'Other',
      _order: i,
      _cost: costOf(a.costHint),
      _params: Object.keys(a.schema?.properties || {}).length,
    })),
    [actions],
  );

  const columns: Column<Row>[] = useMemo(() => [{ key: '_search', label: 'Endpoint' }], []);
  const sortOptions: SortOption[] = [
    { label: 'Spec order', key: '_order', dir: 1 },
    { label: 'Name A–Z', key: 'name', dir: 1 },
    { label: 'Cheapest first', key: '_cost', dir: 1 },
    { label: 'Fewest inputs', key: '_params', dir: 1 },
  ];
  const sort = sortOptions.find((s) => s.key === sortKey) || sortOptions[0];

  /** Which groups have anything to show under the search — a group with nothing is not drawn. */
  const visibleGroups = useMemo(() => {
    const s = q.trim().toLowerCase();
    return groups.filter((g) => (!tag || g.name === tag) && rows.some((r) => r._tag === g.name && (!s || r._search.toLowerCase().includes(s))));
  }, [groups, rows, q, tag]);

  const status = spend?.status;
  const noKey = !!status && !status.configured;

  return (
    <div className="space-y-5 pb-16">
      <div>
        <Link to="/social" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-emerald-600"><ArrowLeft size={14} /> Social</Link>
      </div>

      {loading && <LoadingState />}

      {!loading && failed && (
        <Notice
          tone="warn"
          icon={<AlertTriangle size={20} />}
          title="We could not load this platform"
          body="Something went wrong on the way to the server. Try again in a moment."
          action={<button onClick={() => { setLoading(true); load(); }} className={PRIMARY_BTN}><RefreshCw size={15} /> Try again</button>}
        />
      )}

      {!loading && !failed && data && !platform && (
        <Notice
          icon={<Search size={20} />}
          title="We do not know that platform"
          body={data.message || `There is no platform called "${slug}" in the list.`}
          action={<Link to="/social" className={PRIMARY_BTN}><ArrowLeft size={15} /> Back to Social</Link>}
        />
      )}

      {!loading && !failed && platform && (
        <>
          <header className="flex min-w-0 items-start gap-3">
            <PlatformLogo p={platform} size={48} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-2xl font-extrabold">{platform.name}</h1>
              <p className="text-sm text-zinc-500">
                <span data-testid="endpoint-count">{plural(actions.length, 'endpoint')}</span>
                {groups.length > 1 && <> in {plural(groups.length, 'group')}</>} · every one is a read, none asks a confirm
              </p>
            </div>
          </header>

          <CreditStrip balance={spend?.balance ?? null} spentToday={spend?.spentToday ?? 0} ceiling={spend?.ceiling ?? null} status={status} compact />

          {noKey && <NoKeyNotice />}
          {status && status.configured && !status.reachable && (
            <Notice
              tone="warn"
              icon={<AlertTriangle size={20} />}
              title="We cannot reach Scrape Creators right now"
              body={(status.message || 'It did not answer.') + ' The endpoints are still listed; a run will work again once it answers.'}
              action={<Link to="/settings/connections" className={GHOST_BTN}>Check the key</Link>}
            />
          )}

          {actions.length === 0 ? (
            <Notice icon={<Share2 size={20} />} title="No endpoints listed" body="Their spec lists nothing under this platform right now." />
          ) : (
            <>
              {/* One control strip for every group below (BEA-1320 style: chips are the filter). */}
              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative min-w-0 flex-1">
                    <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                    <input aria-label="Search endpoints" placeholder="Search endpoints…" value={q} onChange={(e) => setQ(e.target.value)} className={INPUT + ' pl-9'} />
                  </div>
                  <select aria-label="Sort" value={sort.key} onChange={(e) => setSortKey(e.target.value === '_order' ? '' : e.target.value)} className={INPUT + ' sm:w-44'}>
                    {sortOptions.map((s) => <option key={s.key} value={s.key}>{`Sort: ${s.label}`}</option>)}
                  </select>
                </div>
                {groups.length > 1 && (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Groups">
                    <TagChip on={!tag} onClick={() => setTag('')}>All <span className="opacity-60">{actions.length}</span></TagChip>
                    {groups.map((g) => (
                      <TagChip key={g.name} on={tag === g.name} onClick={() => setTag(tag === g.name ? '' : g.name)}>{g.name} <span className="opacity-60">{g.count}</span></TagChip>
                    ))}
                  </div>
                )}
              </div>

              {visibleGroups.length === 0 && (
                <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-400 dark:border-zinc-700" data-testid="dt-empty">
                  No endpoint matches that. Try a shorter word, or clear the filter.
                </div>
              )}

              {visibleGroups.map((g) => (
                <section key={g.name} data-testid="endpoint-group">
                  <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-500">
                    {g.name}
                    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-500 dark:bg-zinc-800">{g.count}</span>
                  </h2>
                  <DataTable<Row>
                    columns={columns}
                    rows={rows}
                    controls={{ search: q, filters: { _tag: g.name }, sort: { key: sort.key, dir: sort.dir } }}
                    renderCard={(r) => (
                      <EndpointCard
                        e={r}
                        platform={platform}
                        open={open === r.id}
                        onToggle={() => setOpen(open === r.id ? '' : r.id)}
                        noKey={noKey}
                        topUpUrl={spend?.topUpUrl}
                        onRan={refreshSpend}
                      />
                    )}
                    cardsOnly
                    gridClassName="grid grid-cols-1 gap-2"
                    // Big enough that a `?run=` deep link into the largest group today (22) is on
                    // page one; a group past 50 still pages.
                    pageSize={50}
                    emptyText="No endpoint matches that."
                  />
                </section>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

function TagChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ' + (on ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800')}
    >
      {children}
    </button>
  );
}

// ---- one endpoint -----------------------------------------------------------------------------

function EndpointCard({ e, platform, open, onToggle, noKey, topUpUrl, onRan }: { e: Endpoint; platform: Platform; open: boolean; onToggle: () => void; noKey: boolean; topUpUrl?: string; onRan: () => void }) {
  const props = e.schema?.properties || {};
  const required = e.schema?.required || [];
  const nParams = Object.keys(props).length;
  return (
    <div className={'min-w-0 rounded-xl border bg-white transition-colors dark:bg-zinc-900 ' + (open ? 'border-emerald-500/50' : 'border-zinc-200 dark:border-zinc-800')} data-testid="endpoint-card">
      <button onClick={onToggle} aria-expanded={open} className="flex w-full min-w-0 items-start gap-3 p-3 text-left sm:p-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 font-semibold leading-snug break-words">{e.name}</h3>
            {e.method && e.method !== 'GET' && <span className={CHIP + ' bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'}>{e.method}</span>}
            {e.retired && <span className={CHIP + ' bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'} title="The vendor has retired this endpoint. It is still listed so nothing is skipped.">retired</span>}
          </div>
          {e.description && !open && <p className="mt-1 line-clamp-2 break-words text-sm text-zinc-500 dark:text-zinc-400">{e.description}</p>}
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
            <span className={CHIP + ' bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'} title={e.costHint || 'Most endpoints cost 1 credit; the real cost is shown after each run.'}>
              <Coins size={11} /> {e.costHint ? plural(costOf(e.costHint), 'credit') : '~1 credit'}
            </span>
            <span>{nParams === 0 ? 'No inputs' : `${plural(nParams, 'input')}${required.length ? ` · ${required.length} required` : ''}`}</span>
            {e.path && <code className="min-w-0 truncate font-mono text-[11px] text-zinc-400">{e.path}</code>}
          </div>
        </div>
        <span className="shrink-0 pt-0.5 text-zinc-400">{open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
      </button>
      {open && (
        <div className="border-t border-zinc-100 p-3 dark:border-zinc-800 sm:p-4">
          {e.description && <p className="mb-3 break-words text-sm text-zinc-500 dark:text-zinc-400">{e.description}</p>}
          {e.costHint && <p className="mb-3 text-xs text-zinc-400"><Coins size={11} className="mr-1 inline" />{e.costHint}</p>}
          {/* What we KNOW about this endpoint — fields, paging, cost, health, traps (BEA-1368). Read only when opened. */}
          <ToolFacts actionId={e.id} className="mb-3" />
          <RunPanel e={e} platform={platform} noKey={noKey} topUpUrl={topUpUrl} onRan={onRan} />
        </div>
      )}
    </div>
  );
}

// ---- the form + the run -----------------------------------------------------------------------

/** Which field pages the answer, if any — a `cursor` or a `page`. Named by the spec, never guessed. */
function pagingField(e: Endpoint): { name: string; kind: 'cursor' | 'page' } | null {
  const props = e.schema?.properties || {};
  if ('cursor' in props) return { name: 'cursor', kind: 'cursor' };
  if ('page' in props) return { name: 'page', kind: 'page' };
  if ('next_max_id' in props) return { name: 'next_max_id', kind: 'cursor' };
  return null;
}

/** The next cursor out of an answer, wherever the vendor put it. */
function nextCursorOf(data: any): any {
  if (!data || typeof data !== 'object') return null;
  for (const k of ['cursor', 'next_cursor', 'nextCursor', 'next_max_id', 'end_cursor', 'endCursor', 'next_page_token', 'nextPageToken']) {
    const v = data[k];
    if (v !== undefined && v !== null && v !== '' && v !== false) return v;
  }
  return null;
}

/** The `/agent?builder=chat…` URL "Make it an agent" opens (BEA-1372) — the call + a compact view of what it answered. */
export function makeAgentUrl(o: { actionId: string; args: Record<string, any>; label: string; data?: any; credits?: number; notFound?: boolean }): string {
  const sample: Record<string, any> = { credits: num(o.credits) };
  if (o.notFound) sample.notFound = true;
  else if (o.data !== undefined && o.data !== null) {
    const sh = shapeOf(o.data);
    if (sh.shape === 'list') { sample.count = (sh.rows || []).length; sample.listKey = sh.listKey || 'items'; sample.fields = pickColumns((sh.rows || []) as any, 8); }
    else sample.count = 1;
  }
  const q = new URLSearchParams({ builder: 'chat', tool: o.actionId, args: JSON.stringify(o.args || {}), label: o.label, sample: JSON.stringify(sample) });
  return `/agent?${q.toString()}`;
}

function RunPanel({ e, platform, noKey, topUpUrl, onRan }: { e: Endpoint; platform: Platform; noKey: boolean; topUpUrl?: string; onRan: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const fields = useMemo(() => fieldsOf(e), [e]);
  const paging = useMemo(() => pagingField(e), [e]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; outOfCredits?: boolean; topUpUrl?: string } | null>(null);
  /** The vendor answered "nothing found" for these arguments (BEA-1359) — drawn calmly, and still worth an agent. */
  const [empty, setEmpty] = useState<{ text: string; args: Record<string, any> } | null>(null);
  /** Every page fetched so far. One entry for a plain run; more after "load more". */
  const [pages, setPages] = useState<{ data: any; credits?: number; ms?: number; args: Record<string, any> }[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [saving, setSaving] = useState<'doc' | 'capture' | null>(null);

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  const missing = fields.filter((f) => f.required && !String(values[f.name] ?? '').trim()).map((f) => f.name);

  async function run(extra: Record<string, any> = {}, append = false) {
    if (!append && missing.length) {
      setError({ text: `Fill in ${missing.join(', ')} first.` });
      return;
    }
    setBusy(true);
    setError(null);
    setEmpty(null);
    const args: Record<string, any> = argsOf(fields, values);
    Object.assign(args, extra);
    try {
      const r = await fetch('/api/social/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId: e.id, args }) });
      const body: RunResult = await r.json().catch(() => ({ ok: false, error: 'The server did not answer properly.' }));
      if (!r.ok && !body.error) body.error = 'The server did not answer properly.';
      if (!body.ok && body.notFound && !append) {
        // Their "No posts found": nothing matches TODAY — not an error. An agent on a schedule is
        // exactly how you keep asking, so "Make it an agent" stays on offer (BEA-1359).
        setEmpty({ text: body.error || 'Nothing found for that.', args });
        setPages([]);
      } else if (!body.ok) {
        setError({ text: body.error || 'That did not work.', outOfCredits: body.outOfCredits, topUpUrl: body.topUpUrl || topUpUrl });
        if (!append) setPages([]);
      } else {
        const page = { data: body.data, credits: body.credits, ms: body.ms, args };
        setPages((p) => (append ? [...p, page] : [page]));
      }
    } catch {
      setError({ text: 'We could not reach the server. Try again in a moment.' });
    } finally {
      setBusy(false);
      onRan();
    }
  }

  const last = pages[pages.length - 1];
  const nextCursor = last ? nextCursorOf(last.data) : null;
  const canLoadMore = !!last && !!paging && (paging.kind === 'cursor' ? nextCursor !== null : shapeOf(last.data).shape === 'list');
  const atCap = pages.length >= PAGE_CAP;

  function loadMore() {
    if (!paging || !last) return;
    if (paging.kind === 'cursor') run({ [paging.name]: nextCursor }, true);
    else {
      const current = Number(last.args[paging.name] || values[paging.name] || 1) || 1;
      run({ [paging.name]: current + 1 }, true);
    }
  }

  const totalCredits = pages.reduce((n, p) => n + num(p.credits), 0);
  const title = `${platform.name} — ${e.name}`;

  /** The merged answer: a list grows across pages; anything else is the last page. */
  const merged = useMemo(() => {
    if (!pages.length) return null;
    if (pages.length === 1) return pages[0].data;
    const shapes = pages.map((p) => shapeOf(p.data));
    if (shapes.every((s) => s.shape === 'list')) {
      const key = shapes[0].listKey || 'items';
      const rows = shapes.flatMap((s) => s.rows || []);
      const out = { ...(pages[0].data || {}) };
      const [k1, k2] = key.split('.');
      if (k2) out[k1] = { ...(out[k1] || {}), [k2]: rows };
      else if (k1) out[k1] = rows;
      return out;
    }
    return pages[pages.length - 1].data;
  }, [pages]);

  async function saveDoc() {
    if (!merged) return;
    setSaving('doc');
    try {
      const r = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, kind: 'md', tags: ['social', platform.slug], contentText: toMarkdown({ title, endpoint: e.id, args: last?.args || {}, credits: totalCredits, data: merged }) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.id) throw new Error(d?.message || 'failed');
      toast('success', 'Saved to Documents.');
      navigate(`/doc/${d.id}`);
    } catch (err: any) {
      toast('error', 'Could not save it as a document: ' + String(err?.message || 'something went wrong.'));
    } finally {
      setSaving(null);
    }
  }

  async function sendToCapture() {
    if (!merged) return;
    setSaving('capture');
    try {
      const md = toMarkdown({ title, endpoint: e.id, args: last?.args || {}, credits: totalCredits, data: merged });
      const fd = new FormData();
      fd.append('file', new Blob([md], { type: 'text/markdown' }), `${platform.slug}-${e.id.split('.').pop()}.md`);
      fd.append('tags', `social,${platform.slug}`);
      const r = await fetch('/api/items/upload', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || 'failed');
      toast('success', 'Sent to Capture — it is in your brain now.');
    } catch (err: any) {
      toast('error', 'Could not send it to Capture: ' + String(err?.message || 'something went wrong.'));
    } finally {
      setSaving(null);
    }
  }

  /**
   * Hand the tool, the exact arguments just used, a label AND a compact view of the answer to the THINKING
   * builder (BEA-1372: `builder=chat`) — it opens with "You just ran X (args) and got N posts. Is this the
   * kind of thing you want, and how much of it?" and keeps the pre-filled form (BEA-1357, `builder=1`) one
   * tap away as "Repeat exactly this call".
   */
  function makeAgent() {
    const args = last?.args || empty?.args || {};
    navigate(makeAgentUrl({ actionId: e.id, args, label: `${platform.name} · ${e.name}`, data: merged, credits: totalCredits, notFound: !!empty && !last }));
  }

  return (
    <div className="space-y-3" data-testid="run-panel">
      {fields.length === 0 ? (
        <p className="text-sm text-zinc-500">This endpoint takes no inputs — just run it.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map((f) => <FieldInput key={f.name} f={f} value={values[f.name] ?? ''} onChange={(v) => set(f.name, v)} />)}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => run()} disabled={busy || noKey} className={PRIMARY_BTN} data-testid="run-button" title={noKey ? 'Add the key in Settings first' : undefined}>
          {busy && !pages.length ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} {busy && !pages.length ? 'Running…' : 'Run'}
        </button>
        {noKey && <span className="text-xs text-zinc-400">Add the key in Settings to run this.</span>}
        {missing.length > 0 && !noKey && <span className="text-xs text-zinc-400">Needs {missing.join(', ')}</span>}
      </div>

      {empty && (
        <div className="space-y-3" data-testid="run-empty">
          <Notice
            icon={<Search size={20} />}
            title="Nothing found for that — right now"
            body={<>{empty.text.replace(/^.*could not do that: /i, '')} <span className="text-zinc-400">(0 credits)</span>. Their Google-indexed searches sometimes answer this for every query for a while. An agent on a schedule keeps asking and writes the rows the day they appear.</>}
            action={<button onClick={makeAgent} className={GHOST_BTN}><Bot size={15} /> Make it an agent</button>}
          />
        </div>
      )}

      {error && (
        error.outOfCredits ? (
          <Notice
            tone="warn"
            icon={<Coins size={20} />}
            title="Your credits are out"
            body={error.text}
            action={<a href={error.topUpUrl || 'https://scrapecreators.com'} target="_blank" rel="noreferrer" className={PRIMARY_BTN}>Top up at scrapecreators.com <ExternalLink size={14} /></a>}
          />
        ) : (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-300/60 bg-red-50/60 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/5 dark:text-red-300">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error.text}</span>
          </div>
        )
      )}

      {merged !== null && last && (
        <div className="space-y-3" data-testid="run-result">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={CHIP + ' bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'} data-testid="credits-charged">
              <Coins size={11} /> {totalCredits === 0 ? 'cached · 0' : `${totalCredits} credit${totalCredits === 1 ? '' : 's'}`}
            </span>
            {last.ms !== undefined && <span className="text-zinc-400">{(num(last.ms) / 1000).toFixed(1)}s</span>}
            {pages.length > 1 && <span className="text-zinc-400">{pages.length} pages</span>}
            <button onClick={() => setShowRaw((v) => !v)} className="ml-auto text-zinc-500 underline-offset-2 hover:underline">{showRaw ? 'Show it nicely' : 'Raw JSON'}</button>
          </div>

          {showRaw ? <JsonBox data={merged} /> : <ResultView data={merged} />}

          {paging && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              {canLoadMore && !atCap && (
                <button onClick={loadMore} disabled={busy} className={GHOST_BTN + ' !py-1.5 !text-xs'}>
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <ChevronDown size={13} />} Load more
                </button>
              )}
              {canLoadMore && atCap && <span>That is their last page ({PAGE_CAP} is the most a search goes back).</span>}
              {!canLoadMore && paging.kind === 'cursor' && <span>That is everything.</span>}
            </div>
          )}

          <div className="flex flex-wrap gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <button onClick={saveDoc} disabled={!!saving} className={GHOST_BTN}>{saving === 'doc' ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />} Save as Document</button>
            <button onClick={sendToCapture} disabled={!!saving} className={GHOST_BTN}>{saving === 'capture' ? <Loader2 size={15} className="animate-spin" /> : <FilePlus2 size={15} />} Send to Capture</button>
            <button onClick={makeAgent} className={GHOST_BTN}><Bot size={15} /> Make it an agent</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- drawing the answer -----------------------------------------------------------------------

/** The answer, by its shape. Every long thing wraps or scrolls in its own box — never the page. */
function ResultView({ data }: { data: any }) {
  const s = useMemo(() => shapeOf(data), [data]);
  if (s.shape === 'transcript') {
    return (
      <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm leading-relaxed dark:border-zinc-800 dark:bg-zinc-950" data-testid="result-transcript">
        {s.text}
      </div>
    );
  }
  if (s.shape === 'list' && s.rows) return <ListResult rows={s.rows} />;
  if (s.shape === 'profile' && s.fields) return <ProfileCard fields={s.fields} />;
  return <JsonBox data={data} />;
}

type ListRow = Record<string, any> & { _i: number };

function ListResult({ rows }: { rows: Record<string, any>[] }) {
  const cols = useMemo(() => pickColumns(rows), [rows]);
  const flat: ListRow[] = useMemo(() => rows.map((r, i) => {
    const o: ListRow = { _i: i };
    for (const c of cols) {
      const v = cell(r, c);
      o[c] = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
    }
    return o;
  }), [rows, cols]);
  const columns: Column<ListRow>[] = useMemo(() => cols.map((c) => ({
    key: c,
    label: heading(c),
    sortable: true,
    render: (r: ListRow) => <Cell v={r[c]} col={c} />,
  })), [cols]);
  return (
    <div className="min-w-0" data-testid="result-list">
      <DataTable<ListRow>
        columns={columns}
        rows={flat}
        pageSize={10}
        renderCard={(r) => (
          <div className="min-w-0 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            {cols.map((c) => (
              <div key={c} className="flex min-w-0 gap-2 py-0.5">
                <span className="w-24 shrink-0 truncate text-xs text-zinc-400">{heading(c)}</span>
                <span className="min-w-0 flex-1 break-words"><Cell v={r[c]} col={c} /></span>
              </div>
            ))}
          </div>
        )}
        emptyText="Nothing came back."
      />
    </div>
  );
}

function Cell({ v, col }: { v: any; col: string }) {
  const f = format(v, col);
  if (f.kind === 'empty') return <span className="text-zinc-300 dark:text-zinc-600">—</span>;
  if (f.href) return <a href={f.href} target="_blank" rel="noreferrer" className="break-all text-emerald-600 hover:underline">{f.text}</a>;
  if (f.kind === 'number' || f.kind === 'date') return <span className="tabular-nums whitespace-nowrap">{f.text}</span>;
  return <span className="line-clamp-3 break-words" title={f.text.length > 120 ? f.text : undefined}>{f.text}</span>;
}

function ProfileCard({ fields }: { fields: [string, any][] }) {
  const pic = fields.find(([k, v]) => /pic|avatar|image|thumbnail|photo/i.test(k) && typeof v === 'string' && /^https?:\/\//.test(v));
  const rest = fields.filter((f) => f !== pic).slice(0, 24);
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 sm:flex-row" data-testid="result-profile">
      {pic && <img src={String(pic[1])} alt="" className="h-16 w-16 shrink-0 rounded-full object-cover" onError={(ev) => { (ev.target as HTMLImageElement).style.display = 'none'; }} />}
      <dl className="grid min-w-0 flex-1 grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
        {rest.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wide text-zinc-400">{heading(k)}</dt>
            <dd className="min-w-0 break-words"><Cell v={v} col={k} /></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function JsonBox({ data }: { data: any }) {
  let text = '';
  try { text = JSON.stringify(data, null, 2); } catch { text = String(data); }
  return (
    <pre className="max-h-96 max-w-full overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed dark:border-zinc-800 dark:bg-zinc-950" data-testid="result-json">{text}</pre>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" data-testid="platform-loading">
      <div className="flex items-start gap-3">
        <Skeleton className="h-12 w-12 shrink-0" />
        <div className="flex-1 space-y-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-3 w-56" /></div>
      </div>
      <CreditStrip balance={null} spentToday={0} ceiling={null} loading compact />
      <Skeleton className="h-9 w-full" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    </div>
  );
}

export default SocialPlatform;
