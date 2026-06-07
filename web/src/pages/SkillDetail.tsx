import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Wand2, Check, Circle, Pencil, Download, Share2, Upload, Rocket } from 'lucide-react';
import { ShareDialog } from '../ui/ShareDialog';
import { useToast } from '../ui/Toast';

function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export function SkillDetail() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [eUrl, setEUrl] = useState('');
  const [sharing, setSharing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const [showTargets, setShowTargets] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployStatus, setDeployStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  function load() {
    fetch(`/api/skills/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setD)
      .catch(() => setErr('Could not load this skill.'));
  }
  useEffect(() => {
    load();
    fetch('/api/skills/deploy-targets')
      .then((r) => r.json())
      .then((d) => setTargets(d.targets || []))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function doDeploy(target: string) {
    setDeploying(true);
    setDeployStatus(null);
    try {
      const r = await fetch(`/api/skills/${id}/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
      const dd = await r.json().catch(() => ({ ok: false, message: 'Deploy failed' }));
      setDeployStatus({ ok: !!dd.ok, msg: dd.message || (dd.ok ? 'Deployed' : 'Failed') });
      if (dd.ok) {
        toast('success', dd.message);
        setShowTargets(false);
        load();
      } else toast('error', dd.message || 'Deploy failed');
    } catch {
      setDeployStatus({ ok: false, msg: 'Deploy failed' });
      toast('error', 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  }

  async function toggleUsing() {
    const next = !d.inUse;
    const r = await fetch(`/api/skills/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inUse: next }) });
    if (r.ok) setD({ ...d, inUse: next });
  }
  function startEdit() {
    setETitle(d.title);
    setEDesc(d.description);
    setEUrl(d.downloadUrl || '');
    setEditing(true);
  }
  async function saveEdit() {
    const r = await fetch(`/api/skills/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: eTitle, description: eDesc, downloadUrl: eUrl }) });
    if (r.ok) {
      setD(await r.json());
      setEditing(false);
      toast('success', 'Skill updated');
    } else toast('error', 'Could not save');
  }
  async function onUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/skills/${id}/upload`, { method: 'POST', body: fd });
      if (r.ok) {
        toast('success', 'File attached');
        load();
      } else toast('error', (await r.json().catch(() => ({}))).message || 'Upload failed');
    } catch {
      toast('error', 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const inp = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm';
  const using = d?.inUse;

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <Link to="/skills" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={16} /> Back to skills
      </Link>

      {err && <p className="text-amber-500">{err}</p>}

      {d && (
        <>
          <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <div className={'shrink-0 rounded-lg p-2.5 ' + (d.origin === 'downloaded' ? 'bg-blue-500/10 text-blue-500' : 'bg-violet-500/10 text-violet-500')}>
                <Wand2 size={20} />
              </div>
              <div className="min-w-0">
                <div className="text-xs text-zinc-400 capitalize mb-1">{d.origin} · {d.platform === 'chat' ? 'Claude Chat' : 'Claude Code'}</div>
                {editing ? (
                  <input value={eTitle} onChange={(e) => setETitle(e.target.value)} className="w-full text-2xl font-extrabold rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5" />
                ) : (
                  <h1 className="text-3xl font-extrabold tracking-tight leading-tight">{d.title}</h1>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!editing && (
                <>
                  <button onClick={() => setSharing(true)} title="Share" className={'p-2 rounded-lg border ' + (d.shared ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:text-emerald-600 hover:border-emerald-500')}>
                    <Share2 size={15} />
                  </button>
                  <button onClick={startEdit} title="Edit" className="p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:text-emerald-600 hover:border-emerald-500">
                    <Pencil size={15} />
                  </button>
                </>
              )}
              <button onClick={toggleUsing} className={'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ' + (using ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 hover:border-emerald-500 hover:text-emerald-600')}>
                {using ? <><Check size={15} /> Using</> : <><Circle size={15} /> Mark as using</>}
              </button>
            </div>
          </header>

          {editing ? (
            <div className="space-y-3">
              <label className="block text-xs text-zinc-500">Description<textarea value={eDesc} onChange={(e) => setEDesc(e.target.value)} rows={4} className={inp + ' mt-1'} /></label>
              <label className="block text-xs text-zinc-500">Download / source link<input value={eUrl} onChange={(e) => setEUrl(e.target.value)} className={inp + ' mt-1'} /></label>
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditing(false)} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
                <button onClick={saveEdit} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm">Save</button>
              </div>
            </div>
          ) : (
            <>
              {(d.installed || d.usageCount > 0) && (
                <p className="text-sm text-zinc-500">
                  {d.usageCount > 0 ? (
                    <>Used <span className="font-medium text-zinc-700 dark:text-zinc-300">{d.usageCount}×</span> · last used {shortDate(d.lastUsedAt)}</>
                  ) : (
                    <span className="text-amber-600">On your server · never used</span>
                  )}
                </p>
              )}

              {d.description && <p className="border-l-4 border-violet-500 bg-violet-500/5 rounded-r-lg p-4 text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap">{d.description}</p>}

              <div className="flex flex-wrap gap-2">
                {d.hasFile && (
                  <a href={`/api/skills/${id}/download`} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm">
                    <Download size={14} /> Download skill
                  </a>
                )}
                {d.downloadUrl && (
                  <a href={d.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 break-all">
                    <Download size={14} /> Open source link
                  </a>
                )}
                <button onClick={() => fileRef.current?.click()} disabled={uploading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50">
                  <Upload size={14} /> {uploading ? 'Uploading…' : d.hasFile ? 'Replace file' : 'Upload .zip/.md'}
                </button>
                <input ref={fileRef} type="file" accept=".zip,.md,.markdown,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
              </div>

              {targets.length > 0 && (
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <h2 className="font-semibold text-sm flex items-center gap-2">
                      <Rocket size={15} className="text-emerald-600" /> Deploy to server
                    </h2>
                    {!showTargets ? (
                      <button onClick={() => setShowTargets(true)} disabled={deploying} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
                        <Rocket size={14} /> Deploy
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-zinc-400">Install into:</span>
                        {targets.map((t) => (
                          <button key={t} onClick={() => doDeploy(t)} disabled={deploying} className="capitalize rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50">
                            {t}
                          </button>
                        ))}
                        <button onClick={() => setShowTargets(false)} className="text-xs text-zinc-400 hover:text-zinc-600">cancel</button>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-zinc-400 mt-1">Installs this skill into your Claude Code skills folder so you can use it.</p>
                  {deployStatus && <p className={'mt-2 text-sm ' + (deployStatus.ok ? 'text-emerald-600' : 'text-amber-600')}>{deployStatus.ok ? '✓ ' : '⚠ '}{deployStatus.msg}</p>}
                </div>
              )}

              {d.content && (
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4">
                  <h2 className="font-semibold text-sm mb-2">SKILL.md</h2>
                  <pre className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300 font-mono max-h-96 overflow-auto bg-white dark:bg-zinc-950 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">{d.content}</pre>
                </div>
              )}
            </>
          )}
        </>
      )}
      {!d && !err && <p className="text-zinc-400">Loading…</p>}

      {sharing && d && (
        <ShareDialog
          id={d.id}
          title={d.title}
          initialShared={!!d.shared}
          shareEndpoint={`/api/skills/${d.id}/share`}
          publicLink={`${location.origin}/skill/${d.id}`}
          onClose={() => setSharing(false)}
          onChanged={(s) => setD((prev: any) => (prev ? { ...prev, shared: s } : prev))}
        />
      )}
    </div>
  );
}
