import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Plus, Search, Loader2, Sparkles, RefreshCw, Share2, Brain, ListChecks, Download, ExternalLink, Trash2, Pencil, Check, Copy, X } from 'lucide-react';
import { Sheet } from '../../ui/Sheet';
import { DataTable } from '../../ui/DataTable';
import { mdComponents } from '../../ui/markdown';
import { useToast } from '../../ui/Toast';

type Thread = { threadId: string; subject: string; from: string; date: string; snippet: string };
export type GmailRequest = {
  id: string;
  query: string;
  title: string;
  threadId: string | null;
  threadSubject: string | null;
  summary: string;
  shared: boolean;
  shareId: string | null;
  itemId: string | null;
  createdAt: string;
  updatedAt: string;
};

function cleanFrom(from: string) {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<.*>/);
  return (m ? m[1] : from).trim() || from;
}

export function RequestsSection() {
  const [requests, setRequests] = useState<GmailRequest[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<GmailRequest | null>(null);
  const toast = useToast();

  async function load() {
    try {
      const r = await fetch('/api/google/gmail/requests');
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load requests');
      setRequests(d.requests || []);
    } catch (e: any) {
      toast('error', e.message || 'Could not load requests');
      setRequests([]);
    }
  }
  useEffect(() => { load(); }, []);

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold flex items-center gap-2"><Sparkles size={16} className="text-emerald-500" /> Requests</h2>
        <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm">
          <Plus size={15} /> Create a new request
        </button>
      </div>
      <p className="text-xs text-zinc-500 mb-3">Search your email in plain English — I’ll find the thread and write you a clean briefing you can share, save, or turn into tasks.</p>

      <DataTable<GmailRequest>
        columns={[
          { key: 'title', label: 'Request', sortable: true, render: (r) => <span className="font-medium">{r.title}</span> },
          { key: 'threadSubject', label: 'Email', render: (r) => <span className="text-zinc-500">{r.threadSubject || '—'}</span> },
          { key: 'createdAt', label: 'Created', sortable: true, align: 'right', render: (r) => <span className="text-zinc-400 text-xs">{new Date(r.createdAt).toLocaleDateString()}</span> },
        ]}
        rows={requests || []}
        loading={requests === null}
        pageSize={8}
        emptyText="No requests yet — create your first one above."
        sortOptions={[{ label: 'Newest', key: 'createdAt', dir: -1 }, { label: 'Oldest', key: 'createdAt', dir: 1 }, { label: 'A–Z', key: 'title', dir: 1 }]}
        filters={[{ key: 'shared', label: 'Shared', options: [{ value: 'yes', label: 'Shared' }, { value: 'no', label: 'Private' }], match: (row, v) => (v === 'yes' ? row.shared : !row.shared) }]}
        renderCard={(r) => (
          <button onClick={() => setOpen(r)} className="w-full text-left rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 hover:border-emerald-500 transition">
            <div className="font-medium truncate flex items-center gap-1.5">{r.title}{r.shared && <Share2 size={12} className="text-emerald-500 shrink-0" />}</div>
            {r.threadSubject && <div className="text-xs text-zinc-500 truncate mt-0.5">{r.threadSubject}</div>}
            <div className="text-[11px] text-zinc-400 mt-1">{new Date(r.createdAt).toLocaleDateString()}</div>
          </button>
        )}
      />

      {creating && <CreateSheet onClose={() => setCreating(false)} onCreated={(req) => { setCreating(false); load(); setOpen(req); }} />}
      {open && <DetailSheet request={open} onClose={() => setOpen(null)} onChanged={(req) => { setOpen(req); load(); }} onDeleted={() => { setOpen(null); load(); }} />}
    </section>
  );
}

// ---- Create flow: query → pick a thread → build ----
function CreateSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (r: GmailRequest) => void }) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [building, setBuilding] = useState<string | null>(null);
  const toast = useToast();

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    setThreads(null);
    try {
      const r = await fetch('/api/google/gmail/requests/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query.trim() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Search failed');
      setThreads(d.threads || []);
    } catch (e: any) {
      toast('error', e.message || 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  async function build(t: Thread) {
    setBuilding(t.threadId);
    try {
      const r = await fetch('/api/google/gmail/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query.trim(), threadId: t.threadId }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not build the briefing');
      toast('success', 'Briefing ready');
      onCreated(d);
    } catch (e: any) {
      toast('error', e.message || 'Could not build the briefing');
    } finally {
      setBuilding(null);
    }
  }

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold flex items-center gap-2"><Sparkles size={18} className="text-emerald-500" /> New request</h3>
            <button onClick={close} className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-400" />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="e.g. the solar project discussion" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500" />
            </div>
            <button onClick={search} disabled={searching || !query.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm disabled:opacity-50">
              {searching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Search
            </button>
          </div>

          <div className="mt-4">
            {threads === null ? (
              <p className="text-sm text-zinc-400">Type what you’re looking for, then tap <b>Search</b>.</p>
            ) : threads.length ? (
              <>
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-2">Pick the right thread</div>
                <ul className="space-y-2">
                  {threads.map((t) => (
                    <li key={t.threadId}>
                      <button onClick={() => build(t)} disabled={!!building} className="w-full text-left rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 hover:border-emerald-500 transition disabled:opacity-60">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{t.subject}</div>
                            <div className="text-xs text-zinc-500 truncate">{cleanFrom(t.from)}{t.date ? ` · ${new Date(t.date).toLocaleDateString()}` : ''}</div>
                            {t.snippet && <div className="text-xs text-zinc-400 line-clamp-2 mt-0.5">{t.snippet}</div>}
                          </div>
                          {building === t.threadId ? <Loader2 size={16} className="animate-spin text-emerald-500 shrink-0 mt-1" /> : <Sparkles size={15} className="text-zinc-300 dark:text-zinc-600 shrink-0 mt-1" />}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
                {building && <p className="text-xs text-zinc-500 mt-3 flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Reading the thread and writing your briefing…</p>}
              </>
            ) : (
              <p className="text-sm text-zinc-400">No matching emails found. Try different words.</p>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ---- Detail: the briefing + every action ----
function DetailSheet({ request, onClose, onChanged, onDeleted }: { request: GmailRequest; onClose: () => void; onChanged: (r: GmailRequest) => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(request.title);
  const toast = useToast();
  const r = request;

  async function act(key: string, url: string, body?: any, opts?: { method?: string }) {
    setBusy(key);
    try {
      const res = await fetch(url, { method: opts?.method || 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || 'Something went wrong');
      return d;
    } catch (e: any) {
      toast('error', e.message || 'Something went wrong');
      return null;
    } finally {
      setBusy('');
    }
  }

  async function refresh() {
    const d = await act('refresh', `/api/google/gmail/requests/${r.id}/refresh`);
    if (d) { toast('success', 'Rebuilt from the latest emails'); onChanged(d); }
  }
  async function saveTitle() {
    const d = await act('rename', `/api/google/gmail/requests/${r.id}`, { title }, { method: 'PATCH' });
    if (d) { setEditing(false); onChanged(d); }
  }
  async function share() {
    const d = await act('share', `/api/google/gmail/requests/${r.id}/share`, { shared: !r.shared });
    if (d) {
      onChanged({ ...r, shared: d.shared, shareId: d.shareId });
      if (d.shared && d.shareId) {
        const link = `${window.location.origin}/request-view/${d.shareId}`;
        navigator.clipboard?.writeText(link);
        toast('success', 'Public link copied');
      } else toast('success', 'Sharing turned off');
    }
  }
  async function copyLink() {
    if (r.shareId) { navigator.clipboard?.writeText(`${window.location.origin}/request-view/${r.shareId}`); toast('success', 'Link copied'); }
  }
  async function saveMemory() {
    const d = await act('memory', `/api/google/gmail/requests/${r.id}/memory`);
    if (d) toast('success', 'Saved to memory');
  }
  async function toTasks() {
    const d = await act('tasks', `/api/google/gmail/requests/${r.id}/tasks`);
    if (d) toast('success', d.created?.length ? `Added ${d.created.length} task${d.created.length === 1 ? '' : 's'}` : 'No action items found');
  }
  async function capture() {
    const d = await act('capture', `/api/google/gmail/requests/${r.id}/capture`);
    if (d) { toast('success', 'Imported to Capture'); onChanged({ ...r, itemId: d.id }); }
  }
  async function del(close: () => void) {
    if (!confirm('Delete this request? This only removes the saved briefing, not your email.')) return;
    const d = await act('delete', `/api/google/gmail/requests/${r.id}`, undefined, { method: 'DELETE' });
    if (d) { toast('success', 'Deleted'); close(); onDeleted(); }
  }

  const gmailUrl = r.threadId ? `https://mail.google.com/mail/u/0/#all/${r.threadId}` : `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(r.query)}`;

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <div className="p-5">
          <div className="flex items-start justify-between gap-2 mb-1">
            {editing ? (
              <div className="flex-1 flex gap-2">
                <input value={title} onChange={(e) => setTitle(e.target.value)} className="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-sm" />
                <button onClick={saveTitle} disabled={busy === 'rename'} className="px-2 text-emerald-600">{busy === 'rename' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}</button>
              </div>
            ) : (
              <h3 className="text-lg font-bold flex items-center gap-2 min-w-0">
                <span className="truncate">{r.title}</span>
                <button onClick={() => { setTitle(r.title); setEditing(true); }} className="shrink-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><Pencil size={14} /></button>
              </h3>
            )}
            <button onClick={close} className="shrink-0 p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
          {r.threadSubject && <p className="text-xs text-zinc-500 mb-3">From the thread: “{r.threadSubject}”</p>}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 mb-4">
            <ActionBtn icon={RefreshCw} label="Refresh" onClick={refresh} busy={busy === 'refresh'} />
            <ActionBtn icon={Share2} label={r.shared ? 'Shared' : 'Share'} onClick={share} busy={busy === 'share'} active={r.shared} />
            {r.shared && r.shareId && <ActionBtn icon={Copy} label="Copy link" onClick={copyLink} />}
            <ActionBtn icon={Brain} label="Save to memory" onClick={saveMemory} busy={busy === 'memory'} />
            <ActionBtn icon={ListChecks} label="Turn into Tasks" onClick={toTasks} busy={busy === 'tasks'} />
            <ActionBtn icon={Download} label={r.itemId ? 'In Capture' : 'Import to Capture'} onClick={capture} busy={busy === 'capture'} active={!!r.itemId} />
            <a href={gmailUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500"><ExternalLink size={13} /> Open in Gmail</a>
            <ActionBtn icon={Trash2} label="Delete" onClick={() => del(close)} busy={busy === 'delete'} danger />
          </div>

          {/* Briefing */}
          <article className="prose prose-sm prose-zinc dark:prose-invert max-w-none border-t border-zinc-200 dark:border-zinc-800 pt-4">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{r.summary}</ReactMarkdown>
          </article>
        </div>
      )}
    </Sheet>
  );
}

function ActionBtn({ icon: Icon, label, onClick, busy, active, danger }: { icon: any; label: string; onClick: () => void; busy?: boolean; active?: boolean; danger?: boolean }) {
  const base = 'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50 ';
  const tone = danger
    ? 'border-rose-300 dark:border-rose-500/40 text-rose-600 hover:bg-rose-500/10'
    : active
    ? 'border-emerald-500 text-emerald-600'
    : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-emerald-500';
  return (
    <button onClick={onClick} disabled={busy} className={base + tone}>
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />} {label}
    </button>
  );
}
