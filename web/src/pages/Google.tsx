import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Search, Download, Check, Loader2, RefreshCw, HardDrive, FilePlus2, ExternalLink, FileText, CalendarDays, ListChecks, Clock, Circle, Video, Copy, ClipboardList, MessageSquare, Users, Phone } from 'lucide-react';
import { useToast } from '../ui/Toast';

type Status = { connected: boolean; email: string | null; gws: boolean; bridge: boolean };
type Email = { id: string; from: string; subject: string; date: string; snippet: string };
type DriveFile = { id: string; name: string; mimeType: string; modified: string; link: string };
type Event = { id: string; summary: string; start: string | null; end: string | null; location: string | null; link: string | null };
type TaskList = { listId: string; title: string; tasks: { id: string; title: string; due: string | null; notes: string | null }[] };
type Form = { id: string; name: string; modified: string; link: string };
type ChatSpace = { id: string; name: string; type: string };
type Contact = { name: string; email: string | null; phone: string | null };

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
  const [createType, setCreateType] = useState<'doc' | 'sheet' | 'slides'>('doc');
  // Meet
  const [meetLink, setMeetLink] = useState('');
  const [creatingMeet, setCreatingMeet] = useState(false);
  // Calendar + Tasks
  const [events, setEvents] = useState<Event[] | null>(null);
  const [taskLists, setTaskLists] = useState<TaskList[] | null>(null);
  const [doneTasks, setDoneTasks] = useState<Record<string, boolean>>({});
  // Forms / Chat / Contacts (load on demand)
  const [forms, setForms] = useState<Form[] | null>(null);
  const [formsLoading, setFormsLoading] = useState(false);
  const [spaces, setSpaces] = useState<ChatSpace[] | null>(null);
  const [spacesNote, setSpacesNote] = useState('');
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactQ, setContactQ] = useState('');
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

  async function createFile() {
    if (!docTitle.trim() && !(createType === 'doc' && docBody.trim())) return;
    setCreating(true);
    setCreatedLink('');
    try {
      const ep = createType === 'doc' ? '/api/google/docs/create' : createType === 'sheet' ? '/api/google/sheets/create' : '/api/google/slides/create';
      const payload = createType === 'doc' ? { title: docTitle, content: docBody } : { title: docTitle };
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not create');
      setCreatedLink(d.link);
      toast('success', `${createType === 'doc' ? 'Doc' : createType === 'sheet' ? 'Sheet' : 'Slides'} created`);
    } catch (e: any) {
      toast('error', e.message || 'Could not create');
    } finally {
      setCreating(false);
    }
  }

  async function loadForms() {
    setFormsLoading(true);
    try {
      const r = await fetch('/api/google/forms');
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load forms');
      setForms(d.forms || []);
    } catch (e: any) {
      toast('error', e.message || 'Could not load forms');
    } finally {
      setFormsLoading(false);
    }
  }

  async function loadSpaces() {
    setSpacesLoading(true);
    try {
      const r = await fetch('/api/google/chat');
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load Chat');
      setSpaces(d.spaces || []);
      setSpacesNote(d.available === false ? d.note || '' : '');
    } catch (e: any) {
      toast('error', e.message || 'Could not load Chat');
    } finally {
      setSpacesLoading(false);
    }
  }

  async function loadContacts() {
    setContactsLoading(true);
    try {
      const r = await fetch('/api/google/contacts');
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load contacts');
      setContacts(d.contacts || []);
    } catch (e: any) {
      toast('error', e.message || 'Could not load contacts');
    } finally {
      setContactsLoading(false);
    }
  }

  async function createMeet() {
    setCreatingMeet(true);
    setMeetLink('');
    try {
      const r = await fetch('/api/google/meet/create', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not create a Meet');
      setMeetLink(d.uri || '');
      toast('success', 'Meet link created');
    } catch (e: any) {
      toast('error', e.message || 'Could not create a Meet');
    } finally {
      setCreatingMeet(false);
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

      {/* Create a new Google file (safe write) */}
      {connected && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-1"><FilePlus2 size={16} className="text-blue-500" /> Create</h2>
          <p className="text-xs text-zinc-500 mb-3">Make a brand-new Google file. (Only creates new files — never edits or deletes your existing Drive.)</p>
          <div className="flex gap-2 mb-2">
            <select value={createType} onChange={(e) => setCreateType(e.target.value as any)} className="rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2.5 py-2 text-sm">
              <option value="doc">Doc</option>
              <option value="sheet">Sheet</option>
              <option value="slides">Slides</option>
            </select>
            <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder="Title" className="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
          </div>
          {createType === 'doc' && <textarea value={docBody} onChange={(e) => setDocBody(e.target.value)} rows={4} placeholder="Content (optional)…" className="w-full resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />}
          <div className="mt-3 flex items-center gap-3">
            <button onClick={createFile} disabled={creating || (!docTitle.trim() && !(createType === 'doc' && docBody.trim()))} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
              {creating ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><FilePlus2 size={14} /> Create {createType === 'doc' ? 'Doc' : createType === 'sheet' ? 'Sheet' : 'Slides'}</>}
            </button>
            {createdLink && <a href={createdLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-emerald-600 hover:underline">Open it <ExternalLink size={13} /></a>}
          </div>
        </section>
      )}

      {/* Meet — create a link */}
      {connected && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-1"><Video size={16} className="text-green-600" /> Google Meet</h2>
          <p className="text-xs text-zinc-500 mb-3">Spin up a fresh meeting link in one tap.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={createMeet} disabled={creatingMeet} className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
              {creatingMeet ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><Video size={14} /> Create a Meet link</>}
            </button>
            {meetLink && (
              <span className="inline-flex items-center gap-2 text-sm">
                <a href={meetLink} target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline break-all">{meetLink.replace(/^https?:\/\//, '')}</a>
                <button onClick={() => { navigator.clipboard?.writeText(meetLink); toast('success', 'Copied'); }} title="Copy" className="p-1 text-zinc-400 hover:text-emerald-600"><Copy size={13} /></button>
              </span>
            )}
          </div>
        </section>
      )}

      {/* Google Forms */}
      {connected && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold flex items-center gap-2"><ClipboardList size={16} className="text-purple-500" /> Forms</h2>
            <button onClick={loadForms} disabled={formsLoading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 disabled:opacity-50">
              {formsLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {forms === null ? 'Load' : 'Refresh'}
            </button>
          </div>
          {forms === null ? (
            <p className="text-sm text-zinc-400">Tap <b>Load</b> to list your Google Forms.</p>
          ) : forms.length ? (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {forms.map((f) => (
                <li key={f.id} className="flex items-center gap-2 py-2.5">
                  <ClipboardList size={14} className="shrink-0 text-zinc-400" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{f.name}</div>
                    {f.modified && <div className="text-[11px] text-zinc-400">{new Date(f.modified).toLocaleDateString()}</div>}
                  </div>
                  <a href={f.link} target="_blank" rel="noreferrer" title="Open form" className="shrink-0 p-1 text-zinc-400 hover:text-emerald-600"><ExternalLink size={14} /></a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-zinc-400">No forms yet. When you create Google Forms they’ll show up here.</p>
          )}
        </section>
      )}

      {/* Google Chat */}
      {connected && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold flex items-center gap-2"><MessageSquare size={16} className="text-teal-500" /> Chat</h2>
            <button onClick={loadSpaces} disabled={spacesLoading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 disabled:opacity-50">
              {spacesLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {spaces === null ? 'Load' : 'Refresh'}
            </button>
          </div>
          {spaces === null ? (
            <p className="text-sm text-zinc-400">Tap <b>Load</b> to list your Chat spaces and direct messages.</p>
          ) : spaces.length ? (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {spaces.map((s) => (
                <li key={s.id} className="flex items-center gap-2 py-2.5">
                  <MessageSquare size={14} className="shrink-0 text-zinc-400" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{s.name}</div>
                    <div className="text-[11px] text-zinc-400 capitalize">{String(s.type).replace(/_/g, ' ').toLowerCase()}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : spacesNote ? (
            <p className="text-sm text-zinc-400">{spacesNote}</p>
          ) : (
            <p className="text-sm text-zinc-400">No Chat spaces yet. Rooms and direct messages will appear here.</p>
          )}
        </section>
      )}

      {/* Google Contacts */}
      {connected && (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold flex items-center gap-2"><Users size={16} className="text-sky-500" /> Contacts</h2>
            <button onClick={loadContacts} disabled={contactsLoading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 disabled:opacity-50">
              {contactsLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {contacts === null ? 'Load' : 'Refresh'}
            </button>
          </div>
          {contacts === null ? (
            <p className="text-sm text-zinc-400">Tap <b>Load</b> to list your Google Contacts.</p>
          ) : contacts.length ? (
            <>
              <div className="relative mb-3">
                <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-400" />
                <input value={contactQ} onChange={(e) => setContactQ(e.target.value)} placeholder="Filter by name, email or phone…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500" />
              </div>
              {(() => {
                const term = contactQ.trim().toLowerCase();
                const shown = term ? contacts.filter((c) => `${c.name} ${c.email || ''} ${c.phone || ''}`.toLowerCase().includes(term)) : contacts;
                return shown.length ? (
                  <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {shown.map((c, i) => (
                      <li key={`${c.email || c.name}-${i}`} className="flex items-center gap-3 py-2.5">
                        <span className="shrink-0 w-8 h-8 rounded-full bg-sky-500/10 text-sky-600 inline-flex items-center justify-center text-xs font-semibold uppercase">{(c.name || '?').charAt(0)}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">{c.name}</div>
                          <div className="text-[11px] text-zinc-400 truncate flex items-center gap-2">
                            {c.email && <span className="inline-flex items-center gap-1"><Mail size={10} /> {c.email}</span>}
                            {c.phone && <span className="inline-flex items-center gap-1"><Phone size={10} /> {c.phone}</span>}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-zinc-400">No contacts match “{contactQ}”.</p>
                );
              })()}
              <p className="mt-2 text-[11px] text-zinc-400">{contacts.length} contact{contacts.length === 1 ? '' : 's'}</p>
            </>
          ) : (
            <p className="text-sm text-zinc-400">No contacts found.</p>
          )}
        </section>
      )}
    </div>
  );
}
