import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Wand2, Check, Circle, Pencil, Download } from 'lucide-react';
import { useToast } from '../ui/Toast';

export function SkillDetail() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [eUrl, setEUrl] = useState('');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  const inp = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm';
  const done = d?.inUse;

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
                <button onClick={startEdit} title="Edit" className="p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:text-emerald-600 hover:border-emerald-500">
                  <Pencil size={15} />
                </button>
              )}
              <button onClick={toggleUsing} className={'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ' + (done ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 hover:border-emerald-500 hover:text-emerald-600')}>
                {done ? <><Check size={15} /> Using</> : <><Circle size={15} /> Mark as using</>}
              </button>
            </div>
          </header>

          {editing ? (
            <div className="space-y-3">
              <label className="block text-xs text-zinc-500">What it does / why<textarea value={eDesc} onChange={(e) => setEDesc(e.target.value)} rows={4} className={inp + ' mt-1'} /></label>
              <label className="block text-xs text-zinc-500">Download / source link<input value={eUrl} onChange={(e) => setEUrl(e.target.value)} className={inp + ' mt-1'} /></label>
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditing(false)} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
                <button onClick={saveEdit} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm">Save</button>
              </div>
            </div>
          ) : (
            <>
              {d.description && <p className="border-l-4 border-violet-500 bg-violet-500/5 rounded-r-lg p-4 text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap">{d.description}</p>}
              {d.downloadUrl && (
                <a href={d.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 break-all">
                  <Download size={14} /> Download / open source
                </a>
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
    </div>
  );
}
