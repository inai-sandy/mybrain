import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wand2, Plus, X, Download, Share2, Github, Loader2, Rocket, Package, RefreshCw, Wrench, Trash2, ChevronDown, ChevronRight, Stethoscope } from 'lucide-react';
import { DataTable, Column, Filter, SortOption } from '../ui/DataTable';
import { ShareDialog } from '../ui/ShareDialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';

type Skill = {
  id: string;
  title: string;
  description: string;
  origin: string;
  platform: string;
  downloadUrl: string | null;
  hasFile: boolean;
  inUse: boolean | null;
  installed: boolean;
  deployedTo?: string[];
  installedOn?: string[];
  lastUsedAt: string | null;
  usageCount: number;
  shared: boolean;
  createdAt: string;
  // source tracking / pack grouping (BEA-977)
  sourceRepo?: string | null;
  skillPath?: string | null;
  sourceUrl?: string | null;
  packId?: string | null;
  packName?: string | null;
  fromSource?: boolean;
  bundleCount?: number;
  sourceUpdatedAt?: string | null;
};


type Found = { token: string; repo: string; pack?: { id: string; name: string; isPack: boolean }; skills: { path: string; name: string; description: string; alreadyInLibrary: boolean }[] };

function AddSkillModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [mode, setMode] = useState<'github' | 'paste'>('github');
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [origin, setOrigin] = useState('created');
  const [platform, setPlatform] = useState('code');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [busy, setBusy] = useState(false);
  // GitHub import (BEA-635)
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [deployAfter, setDeployAfter] = useState(true);
  const [installMode, setInstallMode] = useState<'separate' | 'bundle'>('separate');
  const [importing, setImporting] = useState(false);
  const toast = useToast();

  async function fetchRepo() {
    if (!url.trim()) { toast('error', 'Paste a GitHub URL'); return; }
    setFetching(true); setFound(null);
    try {
      const r = await fetch('/api/skills/import/github/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast('error', d.message || 'Could not read that repo'); return; }
      setFound(d);
      const init: Record<string, boolean> = {};
      for (const s of d.skills) init[s.path] = !s.alreadyInLibrary; // pre-pick the new ones
      setSel(init);
      // A multi-skill repo defaults to ONE bundle — installing 13 loose skills should be a deliberate choice, not the default (BEA-980).
      setInstallMode(d.pack?.isPack ? 'bundle' : 'separate');
    } catch { toast('error', 'Could not read that repo'); } finally { setFetching(false); }
  }
  async function doImport() {
    const paths = found ? found.skills.filter((s) => sel[s.path]).map((s) => s.path) : [];
    if (!paths.length) { toast('error', 'Pick at least one skill'); return; }
    setImporting(true);
    try {
      const bundle = installMode === 'bundle' && paths.length > 1;
      const r = await fetch('/api/skills/import/github/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: found!.token, paths, deploy: deployAfter, sourceUrl: url, bundle }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast('error', d.message || 'Import failed'); return; }
      const n = d.started ?? paths.length;
      toast('success', bundle ? `Bundling ${paths.length} skills into one — it'll appear in a moment.` : `Importing ${n} skill${n !== 1 ? 's' : ''}${deployAfter ? ' + deploying' : ''} — they'll appear in a moment.`);
      onCreated(); onClose();
    } catch { toast('error', 'Import failed'); } finally { setImporting(false); }
  }

  async function submit() {
    if (!title.trim() && !content.trim()) {
      toast('error', 'Add a title or paste the skill content');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, content, origin, platform, downloadUrl }),
      });
      if (r.ok) {
        toast('success', 'Skill added');
        onCreated();
        onClose();
      } else toast('error', (await r.json().catch(() => ({}))).message || 'Could not save');
    } catch {
      toast('error', 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const inp = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500';
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full sm:max-w-lg max-h-[90vh] overflow-auto rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold flex items-center gap-2">
            <Wand2 className="text-violet-500" size={18} /> Add skill
          </h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
            <X size={18} />
          </button>
        </div>

        <div className="mb-4 flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
          {([['github', 'From GitHub'], ['paste', 'Paste SKILL.md']] as const).map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)} className={'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' + (mode === m ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300')}>
              {label}
            </button>
          ))}
        </div>

        {mode === 'github' ? (
          <div className="space-y-3">
            <label className="block text-xs text-zinc-500">
              GitHub URL (a repo, a sub-folder, or a SKILL.md)
              <div className="mt-1 flex gap-2">
                <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && fetchRepo()} placeholder="https://github.com/owner/repo" className={inp + ' font-mono'} />
                <button onClick={fetchRepo} disabled={fetching} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-sm text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900">
                  {fetching ? <Loader2 size={15} className="animate-spin" /> : <Github size={15} />} Fetch
                </button>
              </div>
            </label>
            {found && (
              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
                  <span>{found.skills.length} skill{found.skills.length !== 1 ? 's' : ''} in <b>{found.repo}</b></span>
                  <button onClick={() => { const all = found.skills.every((s) => sel[s.path]); const n: Record<string, boolean> = {}; found.skills.forEach((s) => (n[s.path] = !all)); setSel(n); }} className="hover:text-zinc-700 dark:hover:text-zinc-300">
                    {found.skills.every((s) => sel[s.path]) ? 'Clear all' : 'Select all'}
                  </button>
                </div>
                {/* The choice comes FIRST — burying it under the list made people import 13 flat skills by accident (BEA-980). */}
                {found.pack?.isPack && (
                  <div className="mb-3">
                    <div className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">This repo has {found.skills.length} skills — how do you want them?</div>
                    <div className="grid grid-cols-2 gap-2">
                      {([['bundle', 'As one bundle', 'ONE skill. Pick a style by name inside it. No clutter.'], ['separate', 'Separately', `Each becomes its own skill (/name) — ${found.skills.length} entries.`]] as const).map(([m, label, hint]) => (
                        <button key={m} type="button" onClick={() => setInstallMode(m)} className={'rounded-lg border p-2 text-left transition-colors ' + (installMode === m ? 'border-emerald-500 bg-emerald-500/5' : 'border-zinc-300 dark:border-zinc-700 hover:border-zinc-400')}>
                          <div className="flex items-center gap-1.5 text-sm font-medium">{m === 'bundle' ? <Package size={14} className="text-amber-600" /> : <Wand2 size={14} className="text-violet-500" />}{label}</div>
                          <div className="mt-0.5 text-[11px] text-zinc-500 leading-snug">{hint}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <ul className="max-h-64 space-y-1.5 overflow-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                  {found.skills.map((s) => (
                    <li key={s.path}>
                      <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                        <input type="checkbox" checked={!!sel[s.path]} onChange={(e) => setSel((p) => ({ ...p, [s.path]: e.target.checked }))} className="mt-0.5 accent-emerald-600" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{s.name}</span>
                            {s.alreadyInLibrary && <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">In library</span>}
                          </div>
                          <div className="line-clamp-2 text-xs text-zinc-500">{s.description}</div>
                        </div>
                      </label>
                    </li>
                  ))}
                </ul>
                <label className="mt-3 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                  <input type="checkbox" checked={deployAfter} onChange={(e) => setDeployAfter(e.target.checked)} className="accent-emerald-600" />
                  <Rocket size={13} className="text-emerald-600" /> Install everywhere after import (all your Claude Code folders)
                </label>
              </div>
            )}
          </div>
        ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-500">
              Kind
              <select value={origin} onChange={(e) => setOrigin(e.target.value)} className={inp + ' mt-1'}>
                <option value="created">I created it</option>
                <option value="downloaded">Downloaded / bookmarked</option>
              </select>
            </label>
            <label className="text-xs text-zinc-500">
              Platform
              <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={inp + ' mt-1'}>
                <option value="code">Claude Code</option>
                <option value="chat">Claude Chat</option>
              </select>
            </label>
          </div>
          <label className="block text-xs text-zinc-500">
            Paste the skill's SKILL.md (optional — auto-fills title &amp; description)
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} placeholder="---&#10;name: deep-research&#10;description: ...&#10;---&#10;..." className={inp + ' mt-1 font-mono'} />
          </label>
          <label className="block text-xs text-zinc-500">
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="(auto-filled from content if pasted)" className={inp + ' mt-1'} />
          </label>
          <label className="block text-xs text-zinc-500">
            What it does / why you made it
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inp + ' mt-1'} />
          </label>
          <label className="block text-xs text-zinc-500">
            Download / source link (optional)
            <input value={downloadUrl} onChange={(e) => setDownloadUrl(e.target.value)} placeholder="https://…" className={inp + ' mt-1'} />
          </label>
        </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
          {mode === 'github' ? (
            <button onClick={doImport} disabled={importing || !found} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">
              {importing ? <><Loader2 size={15} className="animate-spin" /> Importing…</> : (() => {
                const n = found ? found.skills.filter((s) => sel[s.path]).length : 0;
                // Say exactly what will happen — no guessing which mode you're in (BEA-980).
                if (found?.pack?.isPack && installMode === 'bundle' && n > 1) return `Bundle ${n} into one skill`;
                if (found?.pack?.isPack && n > 1) return `Import ${n} separately`;
                return `Import${found ? ` ${n}` : ''}`;
              })()}
            </button>
          ) : (
            <button onClick={submit} disabled={busy} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">
              {busy ? 'Saving…' : 'Add skill'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// One card in the list is either a single skill or a Pack (a multi-skill repo), grouped app-side so a
// 12-skill repo shows as ONE tidy card instead of flooding the list (BEA-977).
type Entry = {
  id: string;
  kind: 'single' | 'pack';
  title: string;
  description: string;
  createdAt: string;
  origin: string;
  platform: string;
  skills: Skill[];
  installedOn: string[];
};

function groupEntries(skills: Skill[]): Entry[] {
  const packs = new Map<string, Skill[]>();
  const singles: Skill[] = [];
  for (const s of skills) {
    if (s.packId) { const a = packs.get(s.packId) || []; a.push(s); packs.set(s.packId, a); }
    else singles.push(s);
  }
  const entries: Entry[] = [];
  for (const [packId, arr] of packs) {
    if (arr.length === 1) { singles.push(arr[0]); continue; } // a pack down to one skill = just a single card
    const newest = arr.map((x) => x.createdAt).sort().slice(-1)[0] || arr[0].createdAt;
    entries.push({
      id: 'pack:' + packId, kind: 'pack',
      title: arr[0].packName || packId,
      description: arr.map((x) => x.title).join(', '),
      createdAt: newest, origin: 'downloaded', platform: 'code',
      skills: arr, installedOn: Array.from(new Set(arr.flatMap((x) => x.installedOn || []))),
    });
  }
  for (const s of singles) entries.push({
    id: 'skill:' + s.id, kind: 'single', title: s.title, description: s.description,
    createdAt: s.createdAt, origin: s.origin, platform: s.platform, skills: [s], installedOn: s.installedOn || [],
  });
  return entries;
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState<Skill | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<{ kind: 'skill' | 'pack'; id: string; title: string } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  async function load() {
    try {
      const r = await fetch('/api/skills');
      if (r.ok) setSkills((await r.json()).skills || []);
    } finally {
      setLoading(false);
    }
  }
  function loadSoon() {
    load();
    [3000, 8000, 16000, 28000].forEach((ms) => setTimeout(load, ms));
  }
  useEffect(() => { load(); }, []);

  const setB = (k: string, v: boolean) => setBusy((p) => ({ ...p, [k]: v }));

  async function toggleUsing(s: Skill) {
    const next = !s.inUse;
    const r = await fetch(`/api/skills/${s.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inUse: next }) });
    if (r.ok) setSkills((prev) => prev.map((x) => (x.id === s.id ? { ...x, inUse: next } : x)));
    else toast('error', 'Could not update');
  }

  async function updateSkill(s: Skill) {
    setB(s.id, true);
    try {
      const r = await fetch(`/api/skills/${s.id}/update`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast('error', d.message || 'Update failed'); return; }
      toast('success', d.message || (d.updated ? 'Updated' : 'Already up to date'));
      if (d.newSkills?.length) toast('success', `${d.newSkills.length} new skill${d.newSkills.length !== 1 ? 's' : ''} available in this repo — re-import to add.`);
      load();
    } catch { toast('error', 'Update failed'); } finally { setB(s.id, false); }
  }

  async function repairSkill(s: Skill) {
    setB(s.id, true);
    try {
      const r = await fetch(`/api/skills/${s.id}/repair`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      toast(r.ok ? 'success' : 'error', d.message || (r.ok ? 'Repaired' : 'Repair failed'));
      load();
    } catch { toast('error', 'Repair failed'); } finally { setB(s.id, false); }
  }

  async function updatePack(packId: string) {
    setB('pack:' + packId, true);
    try {
      const r = await fetch(`/api/skills/pack/${packId}/update`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast('error', d.message || 'Update failed'); return; }
      toast('success', `Pack updated — ${d.updated} refreshed, ${d.upToDate} already current.`);
      if (d.newSkills?.length) toast('success', `${d.newSkills.length} new skill${d.newSkills.length !== 1 ? 's' : ''} in this repo — re-import to add.`);
      load();
    } catch { toast('error', 'Update failed'); } finally { setB('pack:' + packId, false); }
  }

  async function doRemove() {
    if (!confirm) return;
    const c = confirm; setConfirm(null); setB(c.id, true);
    try {
      const url = c.kind === 'pack' ? `/api/skills/pack/${c.id}` : `/api/skills/${c.id}?uninstall=true`;
      const r = await fetch(url, { method: 'DELETE' });
      if (!r.ok) { toast('error', 'Could not remove'); return; }
      toast('success', c.kind === 'pack' ? 'Pack removed' : 'Removed');
      load();
    } catch { toast('error', 'Could not remove'); } finally { setB(c.id, false); }
  }

  async function runCleanup() {
    setCleaning(true);
    try {
      const s = await (await fetch('/api/skills/cleanup')).json().catch(() => ({ duplicates: [], broken: [] }));
      const dupCount = (s.duplicates || []).reduce((n: number, d: any) => n + (d.remove?.length || 0), 0);
      const brokenCount = (s.broken || []).length;
      if (!dupCount && !brokenCount) { toast('success', 'All clean — no duplicates or broken skills.'); return; }
      if (!window.confirm(`Clean up: remove ${dupCount} duplicate${dupCount !== 1 ? 's' : ''} and repair ${brokenCount} broken header${brokenCount !== 1 ? 's' : ''}?`)) return;
      const r = await (await fetch('/api/skills/cleanup', { method: 'POST' })).json().catch(() => ({}));
      toast('success', `Cleaned up — repaired ${r.repaired || 0}, removed ${r.removed || 0}.`);
      load();
    } catch { toast('error', 'Cleanup failed'); } finally { setCleaning(false); }
  }

  const entries = groupEntries(skills);

  const cols: Column<Entry>[] = [
    { key: 'title', label: 'Title' },
    { key: 'description', label: 'Description' },
  ];
  const filters: Filter[] = [
    { key: 'origin', label: 'Kind', options: [{ value: 'created', label: 'Created' }, { value: 'downloaded', label: 'Downloaded' }], match: (e: Entry, val: string) => e.skills.some((s) => s.origin === val) },
    { key: 'platform', label: 'Platform', options: [{ value: 'code', label: 'Claude Code' }, { value: 'chat', label: 'Claude Chat' }], match: (e: Entry, val: string) => e.skills.some((s) => s.platform === val) },
    {
      key: '_server', label: 'Server',
      options: [{ value: 'sandy', label: 'On Claude · sandy' }, { value: 'beakn', label: 'On Claude · beakn' }, { value: 'none', label: 'Not installed anywhere' }],
      match: (e: Entry, val: string) => (val === 'none' ? !e.installedOn.length : e.installedOn.includes(val)),
    },
  ];
  const sortOptions: SortOption[] = [
    { label: 'Newest', key: 'createdAt', dir: -1 },
    { label: 'Title A–Z', key: 'title', dir: 1 },
  ];

  const installBadges = (on: string[]) => (
    !!on.length && (
      <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
        {on.includes('sandy') && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" title="Installed in Claude · sandy">sandy</span>}
        {on.includes('beakn') && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" title="Installed in Claude · beakn">beakn</span>}
      </span>
    )
  );
  const iconBtn = 'p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40';

  function skillActions(s: Skill, small = false) {
    const sz = small ? 14 : 16;
    return (
      <div className="flex items-center gap-0.5 shrink-0">
        {s.fromSource && (
          <button onClick={() => updateSkill(s)} disabled={busy[s.id]} title="Update from GitHub" className={iconBtn + ' text-zinc-400 hover:text-emerald-600'}>
            {busy[s.id] ? <Loader2 size={sz} className="animate-spin" /> : <RefreshCw size={sz} />}
          </button>
        )}
        <button onClick={() => repairSkill(s)} disabled={busy[s.id]} title="Repair header" className={iconBtn + ' text-zinc-400 hover:text-amber-600'}><Wrench size={sz} /></button>
        <button onClick={() => setSharing(s)} title="Share" className={iconBtn + (s.shared ? ' text-emerald-600' : ' text-zinc-400 hover:text-emerald-600')}><Share2 size={sz} /></button>
        <button onClick={() => setConfirm({ kind: 'skill', id: s.id, title: s.title })} disabled={busy[s.id]} title="Remove" className={iconBtn + ' text-zinc-400 hover:text-red-600'}><Trash2 size={sz} /></button>
      </div>
    );
  }

  function singleCard(s: Skill) {
    return (
      <div className="group h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 flex flex-col transition-all hover:border-emerald-500/40 hover:shadow-md">
        <div className="flex items-start gap-3">
          <div className={'shrink-0 rounded-lg p-2 ' + (s.origin === 'downloaded' ? 'bg-blue-500/10 text-blue-500' : 'bg-violet-500/10 text-violet-500')}><Wand2 size={18} /></div>
          <button onClick={() => navigate(`/skills/${s.id}`)} className="min-w-0 flex-1 text-left">
            <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-emerald-600 flex items-center gap-1.5">
              {s.title}
              {!!s.bundleCount && s.bundleCount > 0 && <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">bundle · {s.bundleCount}</span>}
            </h3>
            <p className="mt-0.5 text-xs text-zinc-400 capitalize">{s.origin} · {s.platform === 'chat' ? 'Claude Chat' : 'Claude Code'}</p>
          </button>
          {skillActions(s)}
        </div>
        {s.description && (
          <button onClick={() => navigate(`/skills/${s.id}`)} className="text-left">
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400 line-clamp-3">{s.description}</p>
          </button>
        )}
        <div className="mt-auto pt-3 flex items-center justify-between text-xs">
          {s.hasFile ? (
            <a href={`/api/skills/${s.id}/download`} className="inline-flex items-center gap-1 text-emerald-600 hover:underline"><Download size={13} /> Download</a>
          ) : s.downloadUrl ? (
            <a href={s.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-600 hover:underline"><Download size={13} /> Open link</a>
          ) : (<span className="text-zinc-400">No link</span>)}
          {installBadges(s.installedOn || [])}
        </div>
      </div>
    );
  }

  function packCard(e: Entry) {
    const open = !!expanded[e.id];
    const pid = e.id.replace(/^pack:/, '');
    return (
      <div className="h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 flex flex-col">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-lg p-2 bg-amber-500/10 text-amber-600"><Package size={18} /></div>
          <button onClick={() => setExpanded((p) => ({ ...p, [e.id]: !open }))} className="min-w-0 flex-1 text-left">
            <h3 className="font-semibold leading-snug flex items-center gap-1.5">{e.title}<span className="text-xs font-normal text-zinc-400">· {e.skills.length} skills</span></h3>
            <p className="mt-0.5 text-xs text-zinc-400 line-clamp-1">{e.description}</p>
          </button>
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => updatePack(pid)} disabled={busy['pack:' + pid]} title="Update all from GitHub" className={iconBtn + ' text-zinc-400 hover:text-emerald-600'}>
              {busy['pack:' + pid] ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            </button>
            <button onClick={() => setConfirm({ kind: 'pack', id: pid, title: e.title })} title="Remove whole pack" className={iconBtn + ' text-zinc-400 hover:text-red-600'}><Trash2 size={16} /></button>
            <button onClick={() => setExpanded((p) => ({ ...p, [e.id]: !open }))} title={open ? 'Collapse' : 'Expand'} className={iconBtn + ' text-zinc-400'}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
          </div>
        </div>
        {open && (
          <ul className="mt-3 space-y-1 border-t border-zinc-100 dark:border-zinc-800 pt-2">
            {e.skills.map((s) => (
              <li key={s.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <button onClick={() => navigate(`/skills/${s.id}`)} className="min-w-0 flex-1 text-left text-sm truncate hover:text-emerald-600">{s.title}</button>
                {skillActions(s, true)}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto pt-3 flex items-center justify-between text-xs">
          <span className="text-zinc-400">Pack of {e.skills.length}</span>
          {installBadges(e.installedOn)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><Wand2 className="text-violet-500" /> Skills</h1>
          <p className="text-zinc-500 text-sm">Install skills from GitHub, keep them updated, and clean out duplicates.</p>
        </div>
        <button onClick={runCleanup} disabled={cleaning} title="Find duplicates & broken skills" className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50">
          {cleaning ? <Loader2 size={15} className="animate-spin" /> : <Stethoscope size={15} />} <span className="hidden sm:inline">Clean up</span>
        </button>
      </div>

      <DataTable<Entry>
        columns={cols}
        rows={entries}
        loading={loading}
        filters={filters}
        sortOptions={sortOptions}
        renderCard={(e) => (e.kind === 'pack' ? packCard(e) : singleCard(e.skills[0]))}
        cardsOnly
        pageSize={12}
        emptyText="No skills yet — tap “＋ Add skill” to install one from GitHub."
      />

      <button onClick={() => setAdding(true)} title="Add skill" className="fixed right-4 bottom-[calc(10rem+env(safe-area-inset-bottom))] md:bottom-24 md:right-6 z-30 inline-flex items-center gap-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 px-4 py-3">
        <Plus size={20} />
        <span className="hidden sm:inline font-medium pr-1">Add skill</span>
      </button>

      {adding && <AddSkillModal onClose={() => setAdding(false)} onCreated={loadSoon} />}
      {sharing && (
        <ShareDialog
          id={sharing.id}
          title={sharing.title}
          initialShared={sharing.shared}
          shareEndpoint={`/api/skills/${sharing.id}/share`}
          publicLink={`${location.origin}/skill/${sharing.id}`}
          onClose={() => setSharing(null)}
          onChanged={() => load()}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === 'pack' ? 'Remove this whole pack?' : 'Remove this skill?'}
        message={confirm ? `“${confirm.title}”${confirm.kind === 'pack' ? ' and all its skills' : ''} will be removed from your library and uninstalled from every folder.` : ''}
        confirmLabel="Remove"
        onCancel={() => setConfirm(null)}
        onConfirm={doRemove}
      />
    </div>
  );
}
