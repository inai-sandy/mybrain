import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Search, Download, Check, Loader2, RefreshCw, HardDrive, FilePlus2, ExternalLink, FileText, CalendarDays, ListChecks, Clock, Circle } from 'lucide-react';
import { useToast } from '../ui/Toast';

type Status = { connected: boolean; email: string | null; gws: boolean; bridge: boolean };
type Email = { id: string; from: string; subject: string; date: string; snippet: string };
type DriveFile = { id: string; name: string; mimeType: string; modified: string; link: string };
type Event = { id: string; summary: string; start: string | null; end: string | null; location: string | null; link: string | null };
type TaskList = { listId: string; title: string; tasks: { id: string; title: string; due: string | null; notes: string | null }[] };

function fmtWhen(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const dateOnly = iso.length <= 10;
  return d.toLocaleString(undefined, dateOnly ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fileKind(mt: string) {
  if (mt.includes('document')) return 'Doc';
  if (mt.includes('spreadsheet')) return 'Sheet';
  if (mt.includes('presentation')) return 'Slides';
  if (mt.includes('pdf')) return 'PDF';
  if (mt.includes('folder')) return 'Folder';
  return mt.split('/').pop() || 'File';
}

export function Google() {
  const [status, setStatus] = useState<Status | null>(null);
  const [q, setQ] = useState('');
  const [emails, setEmails] = useState<Email[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<Record<string, boolean>>({});
  const [imported, setImported] = useState<Record<string, boolean>>({});
  // Drive
  const [dq, setDq] = useState('');
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [dLoading, setDLoading] = useState(false);
  // New Doc composer
  const [docTitle, setDocTitle] = useState('');
  const [docBody, setDocBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdLink, setCreatedLink] = useState('');
  // Calendar + Tasks
  const [events, setEvents] = useState<Event[] | null>(null);
  const [taskLists, setTaskLists] = useState<TaskList[] | null>(null);
  const [doneTasks, setDoneTasks] = useState<Record<string, boolean>>({});
  const toast = useToast();

  useEffect(() => {
    fetch('/api/google/status')
      .then((r) => r.json())
      .then((s) => {
        setStatus(s);
        if (s?.connected) {
          fetch('/api/google/calendar').then((r) => (r.ok ? r.json() : null)).then((d) => d && setEvents(d.events || [])).catch(() => undefined);
          fetch('/api/google/tasks').then((r) => (r.ok ? r.json() : null)).then((d) => d && setTaskLists(d.lists || [])).catch(() => undefined);
        }
      })
      .catch(() => setStatus(null));
  }, []);

  async function completeTask(listId: string, taskId: string) {
    setDoneTasks((p) => ({ ...p, [taskId]: true }));
    const r = await fetch(`/api/google/tasks/${listId}/${taskId}/complete`, { method: 'POST' });
    if (r.ok) toast('success', 'Marked done in Google Tasks');
    else {
      setDoneTasks((p) => ({ ...p, [taskId]: false }));
      toast('error', 'Could not update the task');
    }
  }

  async function loadEmails() {
    setLoading(true);
    try {
      const r = await fetch('/api/google/gmail' + (q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''));
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load emails');
      setEmails(d.messages || []);
    } catch (e: any) {
      toast('error', e.message || 'Could not load emails');
    } finally {
      setLoading(false);
    }
  }

  async function importEmail(id: string) {
    setImporting((p) => ({ ...p, [id]: true }));
    try {
      const r = await fetch(`/api/google/gmail/${id}/import`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'Could not import');
      setImported((p) => ({ ...p, [id]: true }));
      toast('success', 'Imported to Capture');
    } catch (e: any) {
      toast('error', e.message || 'Could not import');
    } finally {
      setImporting((p) => ({ ...p, [id]: false }));
    }
  }

  async function loadFiles() {
    setDLoading(true);
    try {
      const r = await fetch('/api/google/drive' + (dq.trim() ? `?q=${encodeURIComponent(dq.trim())}` : ''));
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load files');
      setFiles(d.files || []);
    } catch (e: any) {
      toast('error', e.message || 'Could not load files');
    } finally {
      setDLoading(false);
    }
  }

  async function importFile(id: string) {
    setImporting((p) => ({ ...p, [id]: true }));
    try {
      const r = await fetch(`/api/google/drive/${id}/import`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'Could not import');
      setImported((p) => ({ ...p, [id]: true }));
      toast('success', 'Imported to Capture');
    } catch (e: any) {
      toast('error', e.message || 'Could not import');
    } finally {
      setImporting((p) => ({ ...p, [id]: false }));
    }
  }

  async function createDoc() {
    if (!docTitle.trim() && !docBody.trim()) return;
    setCreating(true);
    setCreatedLink('');
    try {
      const r = await fetch('/api/google/docs/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: docTitle, content: docBody }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not create the doc');
      setCreatedLink(d.link);
      toast('success', 'Google Doc created');
    } catch (e: any) {
      toast('error', e.message || 'Could not create the doc');
    } finally {
      setCreating(false);
    }
  }

  const connected = !!status?.connected;

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-extrabold flex items-center gap-2"><span className="text-blue-500">🟦</span> Google</h1>
        <p className="text-zinc-500 text-sm">Pull your Gmail, Drive, Docs &amp; Sheets into your brain.</p>
      </div>

      {status && !connected ? (
        <div className="rounded-xl border border-amber-300/50 dark:border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-300">
          Google isn’t connected yet. <Link to="/settings" className="font-medium underline hover:text-amber-600">Open Settings → Integrations → Google</Link> and run the one-time <code className="rounded bg-amber-500/10 px-1">gws auth</code> step on your server, then come back.
        </div>
      ) : connected ? (
        <p className="text-sm text-zinc-500">Connected{status?.email ? ` as ${status.email}` : ''}.</p>
      ) : null}

      {/* Calendar — upcoming agenda */}
      {connected && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-3"><CalendarDays size={16} className="text-blue-500" /> Upcoming</h2>
          {events === null ? (
            <p className="text-sm text-zinc-400">Loading your calendar…</p>
          ) : events.length ? (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {events.map((e) => (
                <li key={e.id} className="flex items-start gap-3 py-2">
                  <span className="shrink-0 w-28 text-[11px] text-zinc-400 tabular-nums inline-flex items-center gap-1"><Clock size={11} /> {fmtWhen(e.start)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{e.summary}</div>
                    {e.location && <div className="text-[11px] text-zinc-400 truncate">{e.location}</div>}
                  </div>
                  {e.link && <a href={e.link} target="_blank" rel="noreferrer" className="shrink-0 p-1 text-zinc-400 hover:text-emerald-600"><ExternalLink size={13} /></a>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-zinc-400">Nothing on your calendar coming up.</p>
          )}
        </section>
      )}

      {/* Google Tasks */}
      {connected && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-3"><ListChecks size={16} className="text-violet-500" /> Google Tasks</h2>
          {taskLists === null ? (
            <p className="text-sm text-zinc-400">Loading your tasks…</p>
          ) : taskLists.some((l) => l.tasks.length) ? (
            <div className="space-y-4">
              {taskLists.filter((l) => l.tasks.length).map((l) => (
                <div key={l.listId}>
                  <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">{l.title}</div>
                  <ul className="space-y-1">
                    {l.tasks.map((t) => {
                      const done = doneTasks[t.id];
                      return (
                        <li key={t.id} className="flex items-start gap-2 text-sm">
                          <button onClick={() => completeTask(l.listId, t.id)} disabled={done} className="mt-0.5 shrink-0 text-zinc-300 dark:text-zinc-600 hover:text-emerald-600 disabled:text-emerald-600">
                            {done ? <Check size={16} /> : <Circle size={16} />}
                          </button>
                          <div className="min-w-0">
                            <span className={done ? 'line-through text-zinc-400' : ''}>{t.title}</span>
                            {t.due && <span className="ml-2 text-[11px] text-zinc-400">due {fmtWhen(t.due)}</span>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-400">No open tasks. 🎉</p>
          )}
        </section>
      )}

      {/* Gmail */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h2 className="font-semibold flex items-center gap-2 mb-3"><Mail size={16} className="text-rose-500" /> Gmail</h2>
        <div className="flex gap-2 mb-3">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadEmails()}
              placeholder="Search (e.g. from:srikar, is:starred, has:attachment)…"
              className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </div>
          <button onClick={loadEmails} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm disabled:opacity-50">
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Load
          </button>
        </div>
        {emails === null ? (
          <p className="text-sm text-zinc-400">Tap <b>Load</b> to fetch your recent emails{connected ? '' : ' (after connecting Google)'}.</p>
        ) : emails.length ? (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {emails.map((m) => (
              <li key={m.id} className="flex items-start gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{m.subject}</div>
                  <div className="text-xs text-zinc-400 truncate">{m.from.replace(/<.*>/, '').trim() || m.from}</div>
                  {m.snippet && <div className="text-xs text-zinc-500 line-clamp-1 mt-0.5">{m.snippet}</div>}
                </div>
                <button onClick={() => importEmail(m.id)} disabled={importing[m.id] || imported[m.id]} className={'shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] disabled:opacity-60 ' + (imported[m.id] ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500 hover:text-emerald-600')}>
                  {importing[m.id] ? <Loader2 size={11} className="animate-spin" /> : imported[m.id] ? <><Check size={11} /> Saved</> : <><Download size={11} /> Import</>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-400">No emails found.</p>
        )}
      </section>

      {/* Drive / Docs / Sheets */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h2 className="font-semibold flex items-center gap-2 mb-3"><HardDrive size={16} className="text-amber-500" /> Drive · Docs · Sheets</h2>
        <div className="flex gap-2 mb-3">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-400" />
            <input
              value={dq}
              onChange={(e) => setDq(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadFiles()}
              placeholder="Search Drive by file name…"
              className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </div>
          <button onClick={loadFiles} disabled={dLoading} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm disabled:opacity-50">
            {dLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Load
          </button>
        </div>
        {files === null ? (
          <p className="text-sm text-zinc-400">Tap <b>Load</b> to list your recent Drive files{connected ? '' : ' (after connecting Google)'}.</p>
        ) : files.length ? (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-2 py-2.5">
                <FileText size={14} className="shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{f.name}</div>
                  <div className="text-[11px] text-zinc-400">{fileKind(f.mimeType)}{f.modified ? ` · ${new Date(f.modified).toLocaleDateString()}` : ''}</div>
                </div>
                {f.link && <a href={f.link} target="_blank" rel="noreferrer" title="Open in Drive" className="shrink-0 p-1 text-zinc-400 hover:text-emerald-600"><ExternalLink size={14} /></a>}
                <button onClick={() => importFile(f.id)} disabled={importing[f.id] || imported[f.id]} className={'shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] disabled:opacity-60 ' + (imported[f.id] ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500 hover:text-emerald-600')}>
                  {importing[f.id] ? <Loader2 size={11} className="animate-spin" /> : imported[f.id] ? <><Check size={11} /> Saved</> : <><Download size={11} /> Import</>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-400">No files found.</p>
        )}
      </section>

      {/* Create a new Google Doc (safe write) */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h2 className="font-semibold flex items-center gap-2 mb-1"><FilePlus2 size={16} className="text-blue-500" /> New Google Doc</h2>
        <p className="text-xs text-zinc-500 mb-3">Create a brand-new Google Doc from text. (Only creates new files — never edits or deletes your existing Drive.)</p>
        <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder="Document title" className="w-full mb-2 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
        <textarea value={docBody} onChange={(e) => setDocBody(e.target.value)} rows={4} placeholder="Content…" className="w-full resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
        <div className="mt-3 flex items-center gap-3">
          <button onClick={createDoc} disabled={creating || (!docTitle.trim() && !docBody.trim())} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
            {creating ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><FilePlus2 size={14} /> Create Doc</>}
          </button>
          {createdLink && <a href={createdLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-emerald-600 hover:underline">Open the new Doc <ExternalLink size={13} /></a>}
        </div>
      </section>
    </div>
  );
}
