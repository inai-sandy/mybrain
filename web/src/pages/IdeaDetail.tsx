import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Copy, Check, Circle, Pencil, Upload, FileText, Link2 } from 'lucide-react';
import { useToast } from '../ui/Toast';

export function IdeaDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState('');
  const [eContent, setEContent] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  function load() {
    fetch(`/api/ideas/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setD)
      .catch(() => setErr('Could not load this idea.'));
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(d.researchPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('error', 'Could not copy');
    }
  }

  async function toggleDone() {
    const next = d.status === 'done' ? 'open' : 'done';
    const r = await fetch(`/api/ideas/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
    if (r.ok) setD({ ...d, status: next });
  }

  function startEdit() {
    setETitle(d.title);
    setEContent(d.content);
    setEditing(true);
  }
  async function saveEdit() {
    const r = await fetch(`/api/ideas/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: eTitle, content: eContent }) });
    if (r.ok) {
      setD(await r.json());
      setEditing(false);
      toast('success', 'Idea updated');
    } else toast('error', 'Could not save');
  }

  async function onUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/ideas/${id}/upload`, { method: 'POST', body: fd });
      if (r.ok) {
        toast('success', 'Research doc added & saved to Capture');
        load();
      } else toast('error', (await r.json().catch(() => ({}))).message || 'Upload failed');
    } catch {
      toast('error', 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const done = d?.status === 'done';

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <Link to="/ideas" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={16} /> Back to ideas
      </Link>

      {err && <p className="text-amber-500">{err}</p>}

      {d && (
        <>
          <header>
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
                  <span className={'rounded-full px-2.5 py-1 font-medium ' + (done ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600')}>{done ? 'Done' : 'Open'}</span>
                  <span className="text-zinc-400">{new Date(d.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                  {d.docs?.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-zinc-400">
                      <Link2 size={12} /> {d.docs.length} research doc{d.docs.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                {editing ? (
                  <input value={eTitle} onChange={(e) => setETitle(e.target.value)} className="w-full text-2xl font-extrabold rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5" />
                ) : (
                  <h1 className={'text-3xl font-extrabold tracking-tight leading-tight ' + (done ? 'line-through text-zinc-400' : '')}>{d.title}</h1>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {!editing && (
                  <button onClick={startEdit} title="Edit" className="p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:text-emerald-600 hover:border-emerald-500">
                    <Pencil size={15} />
                  </button>
                )}
                <button
                  onClick={toggleDone}
                  className={'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ' + (done ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 hover:border-emerald-500 hover:text-emerald-600')}
                >
                  {done ? (
                    <>
                      <Check size={15} /> Done
                    </>
                  ) : (
                    <>
                      <Circle size={15} /> Mark as done
                    </>
                  )}
                </button>
              </div>
            </div>
          </header>

          {/* Research docs — prominent, near the top */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <FileText size={15} className="text-emerald-600" /> Research docs
              </h2>
              <button onClick={() => fileRef.current?.click()} disabled={uploading} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
                <Upload size={14} /> {uploading ? 'Uploading…' : 'Upload .md'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.markdown,.txt"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUpload(f);
                }}
              />
            </div>
            {d.docs?.length ? (
              <ul className="space-y-1.5">
                {d.docs.map((doc: any) => (
                  <li key={doc.id}>
                    <button onClick={() => navigate(`/doc/${doc.id}`)} className="w-full flex items-center gap-2 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:text-emerald-600 rounded-lg px-2 py-2 bg-zinc-50 dark:bg-zinc-950 hover:bg-emerald-500/5 border border-zinc-200 dark:border-zinc-800">
                      <FileText size={15} className="shrink-0 text-zinc-400" />
                      <span className="truncate flex-1">{doc.title || 'Untitled'}</span>
                      <Link2 size={14} className="shrink-0 text-zinc-300" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-400">No research docs yet. After running deep-research, upload the report here — it'll also appear in Capture, linked back to this idea.</p>
            )}
          </div>

          {/* Idea content */}
          {editing ? (
            <div className="space-y-3">
              <textarea value={eContent} onChange={(e) => setEContent(e.target.value)} rows={10} className="w-full resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono" />
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditing(false)} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
                <button onClick={saveEdit} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm">Save</button>
              </div>
            </div>
          ) : (
            d.content && (
              <article className="prose prose-zinc dark:prose-invert max-w-none border-t border-zinc-200 dark:border-zinc-800 pt-6">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.content}</ReactMarkdown>
              </article>
            )
          )}

          {/* Deep-research prompt */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold text-sm">Deep-research prompt</h2>
              <button onClick={copy} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs">
                {copied ? (
                  <>
                    <Check size={13} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={13} /> Copy
                  </>
                )}
              </button>
            </div>
            <p className="text-xs text-zinc-400 mb-2">Paste this into Claude Code or Claude chat to run your /deep-research skill.</p>
            <pre className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300 font-mono max-h-72 overflow-auto bg-white dark:bg-zinc-950 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">{d.researchPrompt}</pre>
          </div>
        </>
      )}
      {!d && !err && <p className="text-zinc-400">Loading…</p>}
    </div>
  );
}
