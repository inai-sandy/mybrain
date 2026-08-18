import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Endpoint, FieldInput, GHOST_BTN, INPUT, PRIMARY_BTN, Platform, argsOf, fieldsOf } from './socialShared';

/**
 * "Add another source" on a Social job (BEA-1359) — the builder form and the job's Settings both
 * use it. Pick a platform, pick one of ITS endpoints (the provider's whole list, grouped by the
 * spec's own tags), fill the same schema-generated form the platform page draws, and the source is
 * added with those EXACT arguments pinned — the run fetches it directly, no engine turn, no AI
 * filling anything in. Reads only `/api/social` and `/api/social/platforms/:slug`.
 */
export type SocialSource = { tool: string; args: Record<string, any>; label?: string };

export function AddSourcePanel({ defaultPlatform, taken, onAdd, onCancel }: { defaultPlatform?: string; taken?: string[]; onAdd: (s: SocialSource) => void; onCancel: () => void }) {
  const [platforms, setPlatforms] = useState<Platform[] | null>(null);
  const [slug, setSlug] = useState(defaultPlatform || '');
  const [actions, setActions] = useState<Endpoint[] | null>(null);
  const [actionId, setActionId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);

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

  /** The endpoints grouped by the spec's own first tag, in the order they came. */
  const groups = useMemo(() => {
    const m = new Map<string, Endpoint[]>();
    for (const a of actions || []) { const t = a.tags?.[0] || 'Other'; if (!m.has(t)) m.set(t, []); m.get(t)!.push(a); }
    return [...m.entries()];
  }, [actions]);

  function add() {
    if (!action || !platform || missing.length || already) return;
    onAdd({ tool: action.id, args: argsOf(fields, values), label: `${platform.name} · ${action.name}` });
  }

  return (
    <div className="space-y-2 rounded-xl border border-dashed border-pink-300 p-3 dark:border-pink-500/40" data-testid="add-source">
      <div className="text-xs font-semibold text-pink-700 dark:text-pink-300">Add another source</div>
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
        <label className="block min-w-0 text-xs text-zinc-500">Endpoint
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
        </>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className={GHOST_BTN}>Cancel</button>
        <button type="button" onClick={add} disabled={!action || missing.length > 0 || already} className={PRIMARY_BTN} title={missing.length ? `Fill in ${missing.join(', ')} first` : undefined}><Plus size={15} /> Add source</button>
      </div>
    </div>
  );
}
