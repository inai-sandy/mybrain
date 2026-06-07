import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wand2, Plus, X, Check, Circle, Download, Share2 } from 'lucide-react';
import { DataTable, Column, Filter, SortOption } from '../ui/DataTable';
import { ShareDialog } from '../ui/ShareDialog';
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
  lastUsedAt: string | null;
  usageCount: number;
  shared: boolean;
  createdAt: string;
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function isStale(s: Skill): boolean {
  if (!s.installed) return false;
  if (!s.lastUsedAt) return true;
  return Date.now() - Date.parse(s.lastUsedAt) > 30 * 86400000;
}

function AddSkillModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [origin, setOrigin] = useState('created');
  const [platform, setPlatform] = useState('code');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

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
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
          <button onClick={submit} disabled={busy} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">
            {busy ? 'Saving…' : 'Add skill'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState<Skill | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    try {
      const r = await fetch('/api/skills');
      if (r.ok) setSkills((await r.json()).skills || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function toggleUsing(s: Skill) {
    const next = !s.inUse;
    const r = await fetch(`/api/skills/${s.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inUse: next }) });
    if (r.ok) setSkills((prev) => prev.map((x) => (x.id === s.id ? { ...x, inUse: next } : x)));
    else toast('error', 'Could not update');
  }

  const cols: Column<Skill>[] = [
    { key: 'title', label: 'Title' },
    { key: 'description', label: 'Description' },
  ];
  const filters: Filter[] = [
    { key: 'origin', label: 'Kind', options: [{ value: 'created', label: 'Created' }, { value: 'downloaded', label: 'Downloaded' }] },
    { key: 'platform', label: 'Platform', options: [{ value: 'code', label: 'Claude Code' }, { value: 'chat', label: 'Claude Chat' }] },
    {
      key: '_usage',
      label: 'Usage',
      options: [{ value: 'stale', label: 'Stale / forgotten' }, { value: 'used', label: 'Recently used' }],
      match: (row: Skill, val: string) => (val === 'stale' ? isStale(row) : !isStale(row)),
    },
  ];
  const sortOptions: SortOption[] = [
    { label: 'Newest', key: 'createdAt', dir: -1 },
    { label: 'Least used', key: 'usageCount', dir: 1 },
    { label: 'Title A–Z', key: 'title', dir: 1 },
  ];

  function card(s: Skill) {
    return (
      <div className="group h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 flex flex-col transition-all hover:border-emerald-500/40 hover:shadow-md">
        <div className="flex items-start gap-3">
          <div className={'shrink-0 rounded-lg p-2 ' + (s.origin === 'downloaded' ? 'bg-blue-500/10 text-blue-500' : 'bg-violet-500/10 text-violet-500')}>
            <Wand2 size={18} />
          </div>
          <button onClick={() => navigate(`/skills/${s.id}`)} className="min-w-0 flex-1 text-left">
            <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-emerald-600">{s.title}</h3>
            <p className="mt-0.5 text-xs text-zinc-400 capitalize">{s.origin} · {s.platform === 'chat' ? 'Claude Chat' : 'Claude Code'}</p>
          </button>
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => setSharing(s)} title="Share" className={'p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (s.shared ? 'text-emerald-600' : 'text-zinc-400 hover:text-emerald-600')}>
              <Share2 size={16} />
            </button>
            <button
              onClick={() => toggleUsing(s)}
              title={s.inUse ? 'Using' : 'Mark as using'}
              className={'p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (s.inUse ? 'text-emerald-600' : 'text-zinc-400 hover:text-emerald-600')}
            >
              {s.inUse ? <Check size={16} /> : <Circle size={16} />}
            </button>
          </div>
        </div>
        {s.description && (
          <button onClick={() => navigate(`/skills/${s.id}`)} className="text-left">
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400 line-clamp-3">{s.description}</p>
          </button>
        )}
        <div className="mt-auto pt-3 flex items-center justify-between text-xs">
          {s.hasFile ? (
            <a href={`/api/skills/${s.id}/download`} className="inline-flex items-center gap-1 text-emerald-600 hover:underline">
              <Download size={13} /> Download
            </a>
          ) : s.downloadUrl ? (
            <a href={s.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-600 hover:underline">
              <Download size={13} /> Open link
            </a>
          ) : (
            <span className="text-zinc-400">No link</span>
          )}
          {s.installed ? (
            <span className={isStale(s) ? 'text-amber-600 font-medium' : 'text-zinc-400'} title={`used ${s.usageCount}×`}>
              {s.lastUsedAt ? `used ${shortDate(s.lastUsedAt)}` : 'never used'}
            </span>
          ) : (
            <span className={s.inUse ? 'text-emerald-600' : 'text-zinc-400'}>{s.inUse ? 'In use' : 'Not marked'}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold flex items-center gap-2">
          <Wand2 className="text-violet-500" /> Skills
        </h1>
        <p className="text-zinc-500 text-sm">Track your Claude skills — what you've made, what you use, what to revisit.</p>
      </div>

      <DataTable<Skill>
        columns={cols}
        rows={skills}
        loading={loading}
        filters={filters}
        sortOptions={sortOptions}
        renderCard={card}
        cardsOnly
        pageSize={12}
        emptyText="No skills yet — tap “＋ Add skill” to track one."
      />

      <button
        onClick={() => setAdding(true)}
        title="Add skill"
        className="fixed right-4 bottom-20 md:bottom-6 md:right-6 z-30 inline-flex items-center gap-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 px-4 py-3"
      >
        <Plus size={20} />
        <span className="hidden sm:inline font-medium pr-1">Add skill</span>
      </button>

      {adding && <AddSkillModal onClose={() => setAdding(false)} onCreated={load} />}
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
    </div>
  );
}
