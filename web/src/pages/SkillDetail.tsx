import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Wand2, Check, Circle, Pencil, Download, Share2, Upload, Rocket, Loader2, Trash2, X } from 'lucide-react';
import { ShareDialog } from '../ui/ShareDialog';
import { useToast } from '../ui/Toast';

export function SkillDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [eUrl, setEUrl] = useState('');
  const [sharing, setSharing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ target: string; installed: boolean; slug: string | null }[] | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [alsoUninstall, setAlsoUninstall] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const TARGET_LABEL: Record<string, string> = { sandy: 'Claude · sandy', beakn: 'Claude · beakn', hermes: 'Hermes agent' };
  const labelFor = (t: string) => TARGET_LABEL[t] || t;

  function load() {
    fetch(`/api/skills/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setD)
      .catch(() => setErr('Could not load this skill.'));
  }
  function loadStatus() {
    fetch(`/api/skills/${id}/deploy-status`).then((r) => r.json()).then((d) => setStatus(d.targets || [])).catch(() => setStatus([]));
  }
  useEffect(() => {
    load();
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function doDeploy(target: string) {
    setDeploying(true);
    try {
      const r = await fetch(`/api/skills/${id}/deploy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
      const dd = await r.json().catch(() => ({ ok: false, message: 'Deploy failed' }));
      toast(dd.ok ? 'success' : 'error', dd.message || (dd.ok ? 'Deployed' : 'Deploy failed'));
    } catch { toast('error', 'Deploy failed'); } finally { setDeploying(false); load(); loadStatus(); }
  }

  async function deployEverywhere() {
    setDeploying(true);
    try {
      const r = await fetch(`/api/skills/${id}/deploy-all`, { method: 'POST' });
      const dd = await r.json().catch(() => ({ ok: false }));
      toast(dd.ok ? 'success' : 'error', dd.ok ? 'Deployed to all targets' : 'Some targets failed — see the matrix');
    } catch { toast('error', 'Deploy failed'); } finally { setDeploying(false); load(); loadStatus(); }
  }

  async function undeploy(target: string) {
    setDeploying(true);
    try {
      const r = await fetch(`/api/skills/${id}/undeploy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
      const dd = await r.json().catch(() => ({ ok: false, message: 'Remove failed' }));
      toast(dd.ok ? 'success' : 'error', dd.message || 'Remove failed');
    } catch { toast('error', 'Remove failed'); } finally { setDeploying(false); load(); loadStatus(); }
  }

  const installedTargets = (status || []).filter((t) => t.installed);
  function openDelete() {
    setAlsoUninstall(installedTargets.length > 0);
    setConfirmDel(true);
  }
  async function doDelete() {
    setDeleting(true);
    try {
      const r = await fetch(`/api/skills/${id}?uninstall=${alsoUninstall}`, { method: 'DELETE' });
      if (!r.ok) throw new Error();
      toast('success', alsoUninstall && installedTargets.length ? 'Skill deleted + uninstalled' : 'Skill deleted');
      nav('/skills');
    } catch { toast('error', 'Could not delete'); setDeleting(false); }
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
                  <button onClick={openDelete} title="Delete skill" className="p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:text-rose-500 hover:border-rose-400">
                    <Trash2 size={15} />
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

              {status && status.length > 0 && (
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h2 className="flex items-center gap-2 text-sm font-semibold">
                      <Rocket size={15} className="text-emerald-600" /> Servers
                    </h2>
                    <button onClick={deployEverywhere} disabled={deploying} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">
                      {deploying ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />} Deploy everywhere
                    </button>
                  </div>
                  <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {status.map((t) => (
                      <li key={t.target} className="flex items-center justify-between gap-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {t.installed ? <Check size={16} className="shrink-0 text-emerald-500" /> : <Circle size={16} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
                          <span className="truncate text-sm font-medium">{labelFor(t.target)}</span>
                          <span className={'shrink-0 text-xs ' + (t.installed ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400')}>{t.installed ? 'Installed' : 'Not installed'}</span>
                        </div>
                        {t.installed ? (
                          <button onClick={() => undeploy(t.target)} disabled={deploying} className="shrink-0 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs text-rose-500 hover:border-rose-400 disabled:opacity-50 dark:border-zinc-700">Remove</button>
                        ) : (
                          <button onClick={() => doDeploy(t.target)} disabled={deploying} className="shrink-0 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50 dark:border-zinc-700">Deploy</button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-zinc-400">“Deploy everywhere” installs into all your Claude Code folders <b>and</b> the Hermes agent so your agents can use it.</p>
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

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" onClick={() => !deleting && setConfirmDel(false)}>
          <div className="w-full rounded-t-2xl bg-white p-5 shadow-xl sm:max-w-md sm:rounded-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 font-bold text-rose-600"><Trash2 size={18} /> Delete skill</h3>
              <button onClick={() => setConfirmDel(false)} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">Delete <b>{d.title}</b> from your library? This can't be undone.</p>
            {installedTargets.length > 0 && (
              <>
                <p className="mt-3 text-xs text-zinc-500">Installed on: {installedTargets.map((t) => labelFor(t.target)).join(', ')}</p>
                <label className="mt-2 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
                  <input type="checkbox" checked={alsoUninstall} onChange={(e) => setAlsoUninstall(e.target.checked)} className="accent-rose-600" />
                  Also uninstall it from those servers
                </label>
              </>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmDel(false)} disabled={deleting} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700">Cancel</button>
              <button onClick={doDelete} disabled={deleting} className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50">
                {deleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
