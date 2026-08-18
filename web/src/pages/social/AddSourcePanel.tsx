import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { MAX_TAKE, creatorFieldFor, creatorParamOf } from '../../ui/agentJobFields';
import { Endpoint, FieldInput, GHOST_BTN, INPUT, PRIMARY_BTN, Platform, argsOf, fieldsOf } from './socialShared';

/**
 * "Add another source" on a Social job (BEA-1359) — the builder form and the job's Settings both
 * use it. Pick a platform, pick one of ITS endpoints (the provider's whole list, grouped by the
 * spec's own tags), fill the same schema-generated form the platform page draws, and the source is
 * added with those EXACT arguments pinned — the run fetches it directly, no engine turn, no AI
 * filling anything in. Reads only `/api/social` and `/api/social/platforms/:slug`.
 *
 * **Creators first (BEA-1369):** the same panel with a switch — the endpoint becomes the FINDER
 * (run once), plus "then, for each creator" (an endpoint of the same platform, run once per creator),
 * how many creators, and how many days to keep. Stored under the finder's id as
 * `{ kind:'creators', find:{…}, then:{…} }` — the direct runner and the flow picture read it.
 */
export type SocialSource = { tool: string; args: Record<string, any>; label?: string };

export function AddSourcePanel({ defaultPlatform, taken, onAdd, onCancel }: { defaultPlatform?: string; taken?: string[]; onAdd: (s: SocialSource) => void; onCancel: () => void }) {
  const [platforms, setPlatforms] = useState<Platform[] | null>(null);
  const [slug, setSlug] = useState(defaultPlatform || '');
  const [actions, setActions] = useState<Endpoint[] | null>(null);
  const [actionId, setActionId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  // Creators first (BEA-1369)
  const [creators, setCreators] = useState(false);
  const [thenId, setThenId] = useState('');
  const [take, setTake] = useState('10');
  const [keepDays, setKeepDays] = useState('30');

  useEffect(() => {
    let live = true;
    fetch('/api/social').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((d) => {
      if (!live) return;
      const list: Platform[] = Array.isArray(d?.platforms) ? d.platforms : [];
      setPlatforms(list);
      if (!slug && list.length) setSlug(list[0].slug);
    }).catch(() => { if (live) { setPlatforms([]); setFailed('Could not load the platforms. Try again in a moment.'); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!slug) return;
    let live = true;
    setActions(null); setActionId(''); setValues({});
    fetch(`/api/social/platforms/${encodeURIComponent(slug)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((d) => {
      if (!live) return;
      setActions(Array.isArray(d?.actions) ? d.actions : []);
    }).catch(() => { if (live) { setActions([]); setFailed('Could not load the endpoints. Try again in a moment.'); } });
    return () => { live = false; };
  }, [slug]);

  const platform = platforms?.find((p) => p.slug === slug) || null;
  const action = actions?.find((a) => a.id === actionId) || null;
  const fields = useMemo(() => (action ? fieldsOf(action) : []), [action]);
  const missing = fields.filter((f) => f.required && !String(values[f.name] ?? '').trim()).map((f) => f.name);
  const already = !!actionId && (taken || []).includes(actionId);
  const thenAction = actions?.find((a) => a.id === thenId) || null;
  const takeN = Math.min(MAX_TAKE, Math.max(1, Math.floor(Number(take)) || 0)) || 0;
  const creatorsOk = !creators || (!!thenAction && takeN >= 1);

  /** The endpoints grouped by the spec's own first tag, in the order they came. */
  const groups = useMemo(() => {
    const m = new Map<string, Endpoint[]>();
    for (const a of actions || []) { const t = a.tags?.[0] || 'Other'; if (!m.has(t)) m.set(t, []); m.get(t)!.push(a); }
    return [...m.entries()];
  }, [actions]);

  function add() {
    if (!action || !platform || missing.length || already || !creatorsOk) return;
    if (creators && thenAction) {
      const param = creatorParamOf(thenAction.schema);
      const days = Math.floor(Number(keepDays));
      const then: Record<string, any> = { actionId: thenAction.id, argsFrom: { [param]: creatorFieldFor(param) } };
      if (keepDays.trim() !== '' && Number.isFinite(days) && days >= 1) then.keepDays = days;
      onAdd({ tool: action.id, args: { kind: 'creators', find: { actionId: action.id, args: argsOf(fields, values), take: takeN }, then }, label: `${platform.name} · ${action.name} → ${thenAction.name}` });
      return;
    }
    onAdd({ tool: action.id, args: argsOf(fields, values), label: `${platform.name} · ${action.name}` });
  }

  return (
    <div className="space-y-2 rounded-xl border border-dashed border-pink-300 p-3 dark:border-pink-500/40" data-testid="add-source">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-pink-700 dark:text-pink-300">Add another source</div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-500">
          <input type="checkbox" checked={creators} onChange={(e) => setCreators(e.target.checked)} className="h-4 w-4 accent-pink-600" aria-label="Creators first" />
          Creators first <span className="text-zinc-400">— find creators, then fetch each one</span>
        </label>
      </div>
      {failed && <p className="text-xs text-rose-600">{failed}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block min-w-0 text-xs text-zinc-500">Platform
          {platforms === null ? (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
          ) : (
            <select value={slug} onChange={(e) => setSlug(e.target.value)} className={INPUT + ' mt-1'} aria-label="Platform">
              {platforms.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </select>
          )}
        </label>
        <label className="block min-w-0 text-xs text-zinc-500">{creators ? 'Find creators with' : 'Endpoint'}
          {slug && actions === null ? (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
          ) : (
            <select value={actionId} onChange={(e) => { setActionId(e.target.value); setValues({}); }} className={INPUT + ' mt-1'} aria-label="Endpoint" disabled={!actions?.length}>
              <option value="">{actions?.length ? 'Pick one…' : 'No endpoints'}</option>
              {groups.map(([tag, list]) => (
                <optgroup key={tag} label={tag}>
                  {list.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </optgroup>
              ))}
            </select>
          )}
        </label>
      </div>
      {action && (
        <>
          {action.description && <p className="text-[11px] leading-snug text-zinc-400">{String(action.description).slice(0, 220)}</p>}
          {fields.length === 0 ? (
            <p className="text-[11px] text-zinc-400">This endpoint takes no inputs — it runs as is.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {fields.map((f) => <FieldInput key={f.name} f={f} value={values[f.name] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />)}
            </div>
          )}
          {already && <p className="text-xs text-amber-600">This endpoint is already a source on this job — change its arguments there instead.</p>}
          {creators && (
            <div className="grid gap-2 rounded-lg border border-pink-200/70 bg-pink-50/40 p-2 dark:border-pink-500/20 dark:bg-pink-500/5 sm:grid-cols-3" data-testid="creators-fields">
              <label className="block min-w-0 text-xs text-zinc-500 sm:col-span-1">then, for each creator
                <select value={thenId} onChange={(e) => setThenId(e.target.value)} className={INPUT + ' mt-1'} aria-label="then, for each creator">
                  <option value="">Pick one…</option>
                  {(actions || []).filter((a) => a.id !== action.id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                {thenAction && <span className="mt-1 block text-[11px] text-zinc-400">{creatorParamOf(thenAction.schema)} ← each creator's {creatorFieldFor(creatorParamOf(thenAction.schema))}</span>}
              </label>
              <label className="block min-w-0 text-xs text-zinc-500">how many creators <span className="text-zinc-400">(≤ {MAX_TAKE})</span>
                <input type="number" inputMode="numeric" min={1} max={MAX_TAKE} value={take} onChange={(e) => setTake(e.target.value)} className={INPUT + ' mt-1'} aria-label="how many creators" />
              </label>
              <label className="block min-w-0 text-xs text-zinc-500">keep the last <span className="text-zinc-400">days · blank = all</span>
                <input type="number" inputMode="numeric" min={1} value={keepDays} onChange={(e) => setKeepDays(e.target.value)} className={INPUT + ' mt-1'} aria-label="keep the last days" />
              </label>
              <p className="text-[11px] text-zinc-400 sm:col-span-3">The finder runs once; the first {takeN || '…'} creators it returns each get one call — about {1 + (takeN || 0)} credits per run when each call is 1 credit. Items older than the days you set are dropped when they carry a date.</p>
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className={GHOST_BTN}>Cancel</button>
        <button type="button" onClick={add} disabled={!action || missing.length > 0 || already || !creatorsOk} className={PRIMARY_BTN} title={missing.length ? `Fill in ${missing.join(', ')} first` : creators && !thenAction ? 'Pick the per-creator endpoint first' : undefined}><Plus size={15} /> Add source</button>
      </div>
    </div>
  );
}
