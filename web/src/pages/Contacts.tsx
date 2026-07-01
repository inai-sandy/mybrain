import { useEffect, useRef, useState } from 'react';
import { Search, Plus, Trash2, Pencil, X, Phone, Loader2, MessageCircle, Send, Clock, CheckCircle2, Sparkles, UserPlus, Pause, Play } from 'lucide-react';
import { useToast } from '../ui/Toast';

type Contact = { id: string; name: string; whatsappNumber: string | null; notes: string | null; tags: string[] };
type Reminder = { id: string; contactId: string; taskId: string | null; subject?: string | null; message: string; count: number; times: string[]; status: string; contact?: Contact; task?: { id: string; title: string } | null };

const PAGE_SIZE = 20;

export function Contacts() {
  const [tab, setTab] = useState<'contacts' | 'reminders'>('contacts');
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-extrabold">Contacts</h1>
        <p className="text-sm text-zinc-500">People you chase, and the WhatsApp reminders you send them.</p>
      </header>
      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {(['contacts', 'reminders'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={'-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize transition-colors ' + (tab === t ? 'border-emerald-600 text-emerald-600' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>{t}</button>
        ))}
      </div>
      {tab === 'contacts' ? <ContactsTab /> : <RemindersTab />}
    </div>
  );
}

function ContactsTab() {
  const toast = useToast();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [showForm, setShowForm] = useState(false);

  function load() {
    setContacts((c) => c); // keep current while refreshing
    fetch(`/api/contacts?q=${encodeURIComponent(q)}&page=${page}&pageSize=${PAGE_SIZE}`)
      .then((r) => r.json())
      .then((d) => { setContacts(d.contacts || []); setTotal(d.total || 0); })
      .catch(() => setContacts([]));
  }
  // debounce search; reset to page 1 on query change
  useEffect(() => { const t = setTimeout(() => { setPage(1); }, 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q, page]);

  async function del(c: Contact) {
    if (!window.confirm(`Delete "${c.name}"? Any reminders to them are removed too.`)) return;
    try {
      const r = await fetch(`/api/contacts/${c.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error();
      toast('success', 'Contact deleted');
      load();
    } catch { toast('error', 'Could not delete'); }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
        <Search className="h-4 w-4 shrink-0 text-zinc-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, number or note…" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400" />
        {contacts && <span className="shrink-0 text-xs text-zinc-400">{total}</span>}
      </div>

      {contacts === null ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
      ) : contacts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {q ? `No contacts match “${q}”.` : 'No contacts yet. Add the people you want to chase.'}
        </div>
      ) : (
        <ul className="space-y-2">
          {contacts.map((c) => (
            <li key={c.id} className="group flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">{c.name.slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{c.name}</div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
                  {c.whatsappNumber ? <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />+{c.whatsappNumber}</span> : <span className="text-amber-600">No number yet</span>}
                  {c.notes && <span className="truncate">{c.notes}</span>}
                  {c.tags?.map((t) => <span key={t} className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{t}</span>)}
                </div>
              </div>
              <button onClick={() => { setEditing(c); setShowForm(true); }} title="Edit" className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><Pencil className="h-4 w-4" /></button>
              <button onClick={() => del(c)} title="Delete" className="shrink-0 rounded-lg p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 dark:text-zinc-600 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg px-2 py-1 text-zinc-500 hover:text-zinc-800 disabled:opacity-40 dark:hover:text-zinc-200">Prev</button>
          <span className="text-xs text-zinc-400">Page {page} of {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="rounded-lg px-2 py-1 text-zinc-500 hover:text-zinc-800 disabled:opacity-40 dark:hover:text-zinc-200">Next</button>
        </div>
      )}

      {/* Floating add */}
      <button onClick={() => { setEditing(null); setShowForm(true); }} className="fixed bottom-24 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-lg transition-colors hover:bg-emerald-500">
        <Plus className="h-4 w-4" />Add contact
      </button>

      {showForm && <ContactForm contact={editing} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); load(); }} />}
    </div>
  );
}

function ContactForm({ contact, initialName, onClose, onSaved }: { contact: Contact | null; initialName?: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(contact?.name || initialName || '');
  const [number, setNumber] = useState(contact?.whatsappNumber || '');
  const [notes, setNotes] = useState(contact?.notes || '');
  const [tags, setTags] = useState((contact?.tags || []).join(', '));
  const [saving, setSaving] = useState(false);
  const inp = 'w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700';

  async function save() {
    if (!name.trim()) { toast('error', 'Give the contact a name'); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), whatsappNumber: number.trim(), notes: notes.trim(), tags: tags.split(',').map((t) => t.trim()).filter(Boolean) };
      const r = await fetch(contact ? `/api/contacts/${contact.id}` : '/api/contacts', { method: contact ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).message || 'Could not save');
      toast('success', contact ? 'Contact updated' : 'Contact added');
      onSaved();
    } catch (e: any) { toast('error', e.message || 'Could not save'); setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => !saving && onClose()}>
      <div className="w-full max-w-md space-y-3 rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><MessageCircle className="h-4 w-4 text-emerald-600" />{contact ? 'Edit contact' : 'Add contact'}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
        <label className="block text-xs text-zinc-500">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ravi Kumar" className={inp + ' mt-1'} autoFocus /></label>
        <label className="block text-xs text-zinc-500">WhatsApp number (with country code)<input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. +91 98765 43210" className={inp + ' mt-1'} inputMode="tel" /></label>
        <label className="block text-xs text-zinc-500">Notes (optional)<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inp + ' mt-1 resize-none'} /></label>
        <label className="block text-xs text-zinc-500">Tags (comma-separated)<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vendor, team" className={inp + ' mt-1'} /></label>
        <button onClick={save} disabled={saving} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{contact ? 'Save' : 'Add contact'}</button>
      </div>
    </div>
  );
}

// ---- Reminders tab (BEA-720) ----
const REM_STATUS: Record<string, { label: string; cls: string; icon: typeof Clock }> = {
  active: { label: 'Active', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400', icon: Clock },
  paused: { label: 'Paused', cls: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300', icon: Pause },
  done: { label: 'Done', cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300', icon: CheckCircle2 },
  stopped: { label: 'Stopped', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300', icon: X },
};

/** Mirror of the backend spreadTimes for the live preview. */
function previewTimes(count: number): string[] {
  const n = Math.max(1, Math.min(5, Math.round(count || 1)));
  const start = 9 * 60, end = 16 * 60 + 30, out: string[] = [];
  for (let i = 0; i < n; i++) { const m = n === 1 ? start : Math.round(start + ((end - start) * i) / (n - 1)); out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); }
  return out;
}

type Suggestion = { task: { id: string; title: string; party: string }; contact: Contact | null; noNumber: boolean; hasActiveReminder: boolean };

function RemindersTab() {
  const toast = useToast();
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [prefill, setPrefill] = useState<{ contactId: string; contactName: string; message: string; taskId?: string; subject?: string } | null>(null);
  const [addNumberFor, setAddNumberFor] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  async function scanTasks() {
    setScanning(true);
    try {
      const d = await (await fetch('/api/reminders/scan-tasks', { method: 'POST' })).json();
      toast('success', d.updated > 0 ? `Found ${d.updated} ${d.updated === 1 ? 'person' : 'people'} in your tasks` : 'No new people found — you’re all caught up');
      load();
    } catch { toast('error', 'Could not scan tasks'); } finally { setScanning(false); }
  }

  function load() {
    fetch('/api/reminders').then((r) => r.json()).then((d) => setReminders(d.reminders || [])).catch(() => setReminders([]));
    fetch('/api/reminders/suggestions').then((r) => r.json()).then((d) => setSuggestions((d.suggestions || []).filter((s: Suggestion) => !s.hasActiveReminder))).catch(() => setSuggestions([]));
  }
  useEffect(() => { load(); }, []);

  async function act(id: string, kind: 'pause' | 'resume' | 'delete') {
    if (kind === 'delete' && !window.confirm('Delete this reminder?')) return;
    const url = kind === 'delete' ? `/api/reminders/${id}` : `/api/reminders/${id}/${kind}`;
    try {
      const r = await fetch(url, { method: kind === 'delete' ? 'DELETE' : 'POST' });
      if (!r.ok) throw new Error();
      toast('success', kind === 'pause' ? 'Reminder paused' : kind === 'resume' ? 'Reminder resumed' : 'Reminder deleted');
      load();
    } catch { toast('error', 'Could not update'); }
  }

  async function add(s: Suggestion) {
    if (s.noNumber) { setAddNumberFor(s.task.party); return; } // add a number first
    setDrafting(s.task.id);
    try {
      const d = await (await fetch('/api/reminders/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: s.task.id, contactName: s.contact!.name }) })).json();
      setPrefill({ contactId: s.contact!.id, contactName: s.contact!.name, message: d.message || '', taskId: s.task.id, subject: d.subject || s.task.title });
      setEditing(null);
      setShowForm(true);
    } catch { toast('error', 'Could not draft a message'); } finally { setDrafting(null); }
  }

  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">WhatsApp sending is live — active reminders go out automatically at their scheduled times, and replies get handled for you. Open a reminder's 💬 to see the conversation.</p>

      <div className="flex items-center justify-between">
        <span className="text-[11px] text-zinc-400">Old tasks that name a person can become reminders.</span>
        <button onClick={scanTasks} disabled={scanning} title="Find people mentioned in your open tasks" className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
          {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}Scan tasks for people
        </button>
      </div>

      {suggestions.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400"><Sparkles className="h-3.5 w-3.5 text-emerald-500" />Suggested from your tasks</h3>
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li key={s.task.id} className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.task.title}</div>
                  <div className="text-xs text-zinc-500">Chase <span className="font-medium text-zinc-600 dark:text-zinc-300">{s.task.party}</span>{s.noNumber && <span className="ml-1 text-amber-600">· no number yet</span>}</div>
                </div>
                <button onClick={() => add(s)} disabled={drafting === s.task.id} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                  {drafting === s.task.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : s.noNumber ? <UserPlus className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  {s.noNumber ? 'Add number' : 'Add reminder'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Your reminders</h3>
      {reminders === null ? (
        <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
      ) : reminders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">No reminders yet. Create one below, or add them from your tasks.</div>
      ) : (
        <ul className="space-y-2">
          {reminders.map((rm) => {
            const st = REM_STATUS[rm.status] || REM_STATUS.active;
            return (
              <li key={rm.id} className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-start gap-2">
                  <button onClick={() => setOpenThread(rm.id)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{rm.contact?.name || 'Contact'}</span>
                      <span className={'rounded-full px-2 py-0.5 text-[10px] font-medium ' + st.cls}>{st.label}</span>
                    </div>
                    {rm.task && <div className="text-xs text-zinc-400">re: {rm.task.title}</div>}
                    <p className="mt-1 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-300">{rm.message}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {rm.times.map((t) => <span key={t} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800"><Send className="h-2.5 w-2.5" />{t}</span>)}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center">
                    <button onClick={() => setOpenThread(rm.id)} title="Open chat" className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800"><MessageCircle className="h-4 w-4" /></button>
                    {(rm.status === 'active' || rm.status === 'paused') && <button onClick={() => { setEditing(rm); setShowForm(true); }} title="Edit" className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><Pencil className="h-4 w-4" /></button>}
                    {rm.status === 'active' && <button onClick={() => act(rm.id, 'pause')} title="Pause" className="rounded-lg p-1.5 text-zinc-400 hover:bg-sky-50 hover:text-sky-600 dark:hover:bg-sky-500/10"><Pause className="h-4 w-4" /></button>}
                    {rm.status === 'paused' && <button onClick={() => act(rm.id, 'resume')} title="Resume" className="rounded-lg p-1.5 text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-500/10"><Play className="h-4 w-4" /></button>}
                    <button onClick={() => act(rm.id, 'delete')} title="Delete" className="rounded-lg p-1.5 text-zinc-300 hover:bg-red-50 hover:text-red-600 dark:text-zinc-600 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <button onClick={() => { setEditing(null); setPrefill(null); setShowForm(true); }} className="fixed bottom-24 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-lg hover:bg-emerald-500"><Plus className="h-4 w-4" />New reminder</button>
      {openThread && (() => { const r = reminders.find((x) => x.id === openThread); return r ? <ReminderChat reminder={r} onClose={() => setOpenThread(null)} /> : null; })()}
      {showForm && <NewReminderForm reminder={editing} prefill={prefill} onClose={() => { setShowForm(false); setPrefill(null); }} onSaved={() => { setShowForm(false); setPrefill(null); load(); }} />}
      {addNumberFor !== null && <ContactForm contact={null} initialName={addNumberFor} onClose={() => setAddNumberFor(null)} onSaved={() => { setAddNumberFor(null); load(); }} />}
    </div>
  );
}

/** A full chat window for one reminder — the WhatsApp conversation + captured outcome. (BEA-733) */
function ReminderChat({ reminder, onClose }: { reminder: Reminder; onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ messages: { id: string; direction: string; body: string; at: string }[]; feedback: string | null; status: string } | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const st = REM_STATUS[reminder.status] || REM_STATUS.active;
  const about = reminder.subject || reminder.task?.title;
  useEffect(() => {
    fetch(`/api/reminders/${reminder.id}/thread`).then((r) => r.json()).then(setData).catch(() => setData({ messages: [], feedback: null, status: '' }));
  }, [reminder.id]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [data]);
  const fmt = (s: string) => new Date(s).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await fetch(`/api/reminders/${reminder.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || 'Could not send');
      setData((prev) => (prev ? { ...prev, messages: [...prev.messages, d] } : prev));
      setText('');
    } catch (e: any) {
      toast('error', e.message || 'Could not send');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex w-full flex-col bg-white dark:bg-zinc-900 sm:h-[80vh] sm:max-w-md sm:rounded-2xl sm:border sm:border-zinc-200 sm:shadow-2xl sm:dark:border-zinc-800" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-3 dark:border-zinc-800">
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="h-5 w-5" /></button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{reminder.contact?.name || 'Contact'}</span>
              <span className={'rounded-full px-2 py-0.5 text-[10px] font-medium ' + st.cls}>{st.label}</span>
            </div>
            <div className="truncate text-xs text-zinc-400">
              {reminder.contact?.whatsappNumber ? '+' + reminder.contact.whatsappNumber : 'no number'}{about ? ` · re: ${about}` : ''}
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 space-y-2 overflow-y-auto bg-zinc-50 px-3 py-4 dark:bg-zinc-950/40">
          {!data ? (
            <p className="text-center text-xs text-zinc-400">Loading…</p>
          ) : data.messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-zinc-400">
              <MessageCircle className="h-8 w-8" />
              <p className="text-sm">No messages yet</p>
              <p className="max-w-[240px] text-xs">The nudge sends at the scheduled time{reminder.times?.length ? ` (${reminder.times.join(', ')})` : ''}. Replies — and the agent's answers — appear here.</p>
            </div>
          ) : (
            data.messages.map((m) => (
              <div key={m.id} className={'flex flex-col ' + (m.direction === 'out' ? 'items-end' : 'items-start')}>
                <div className={'max-w-[82%] rounded-2xl px-3 py-2 text-sm ' + (m.direction === 'out' ? 'rounded-br-sm bg-emerald-500/20 text-emerald-950 dark:text-emerald-50' : 'rounded-bl-sm bg-white text-zinc-800 shadow-sm dark:bg-zinc-800 dark:text-zinc-100')}>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                </div>
                <span className="mt-0.5 px-1 text-[10px] text-zinc-400">{m.direction === 'out' ? 'You' : reminder.contact?.name?.split(' ')[0] || 'Them'} · {fmt(m.at)}</span>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>

        {/* Outcome footer */}
        {data?.feedback && (
          <div className="flex items-start gap-1.5 border-t border-zinc-100 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-800 dark:border-zinc-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span><b>Outcome:</b> {data.feedback}</span>
          </div>
        )}

        {/* Compose — send a WhatsApp message to the contact yourself (BEA-736) */}
        <div className="flex items-end gap-2 border-t border-zinc-100 p-2 dark:border-zinc-800">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={1}
            placeholder={`Message ${reminder.contact?.name?.split(' ')[0] || 'them'}…`}
            className="max-h-28 min-h-[40px] flex-1 resize-none rounded-2xl border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700"
          />
          <button onClick={send} disabled={sending || !text.trim()} title="Send" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewReminderForm({ reminder, prefill, onClose, onSaved }: { reminder: Reminder | null; prefill?: { contactId: string; contactName: string; message: string; taskId?: string; subject?: string } | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState(reminder?.contactId || prefill?.contactId || '');
  const [subject, setSubject] = useState(reminder?.subject || prefill?.subject || '');
  const [message, setMessage] = useState(reminder?.message || prefill?.message || '');
  const [count, setCount] = useState(reminder?.count || 3);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const locked = !!reminder || !!prefill; // contact is fixed (editing, or coming from a suggestion)
  const lockedName = reminder?.contact?.name || prefill?.contactName;
  const inp = 'w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700';
  useEffect(() => { if (!locked) fetch('/api/contacts?pageSize=100').then((r) => r.json()).then((d) => setContacts(d.contacts || [])).catch(() => undefined); }, [locked]);

  // Take the user's rough words and reformat them into a proper WhatsApp message.
  async function cleanUp() {
    const text = message.trim();
    if (!text) { toast('error', 'Type roughly what you want to say first'); return; }
    const name = lockedName || contacts.find((c) => c.id === contactId)?.name;
    setCleaning(true);
    try {
      const d = await (await fetch('/api/reminders/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userInput: text, contactName: name }) })).json();
      if (d.message) { setMessage(d.message); toast('success', 'Tidied it up'); }
    } catch { toast('error', 'Could not clean it up'); } finally { setCleaning(false); }
  }

  async function save() {
    if (!locked && !contactId) { toast('error', 'Pick a contact'); return; }
    if (!message.trim()) { toast('error', 'Write the message'); return; }
    setSaving(true);
    try {
      const r = reminder
        ? await fetch(`/api/reminders/${reminder.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: subject.trim(), message: message.trim(), count }) })
        : await fetch('/api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId, taskId: prefill?.taskId, subject: subject.trim(), message: message.trim(), count }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).message || 'Could not save');
      toast('success', reminder ? 'Reminder updated' : 'Reminder created');
      onSaved();
    } catch (e: any) { toast('error', e.message || 'Could not save'); setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => !saving && onClose()}>
      <div className="w-full max-w-md space-y-3 rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Send className="h-4 w-4 text-emerald-600" />{reminder ? 'Edit reminder' : 'New reminder'}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
        {locked ? (
          <div className="text-sm text-zinc-500">To <b className="text-zinc-700 dark:text-zinc-200">{lockedName}</b></div>
        ) : (
          <label className="block text-xs text-zinc-500">Contact
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} className={inp + ' mt-1'}>
              <option value="">Pick a contact…</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.whatsappNumber ? '' : ' (no number)'}</option>)}
            </select>
          </label>
        )}
        <label className="block text-xs text-zinc-500">What's this about?
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. the PCB samples" className={inp + ' mt-1'} />
          <span className="mt-1 block text-[10px] text-zinc-400">Goes into the first WhatsApp nudge: “…a gentle reminder about <b>{subject.trim() || 'this'}</b>.”</span>
        </label>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-zinc-500">{prefill ? 'Message (drafted for you — edit freely)' : 'Message'}</span>
            <button type="button" onClick={cleanUp} disabled={cleaning || !message.trim()} title="Reformat your words into a proper message" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 disabled:opacity-40 dark:hover:bg-emerald-500/10">
              {cleaning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Clean up
            </button>
          </div>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Type roughly what you want to say — then tap Clean up to tidy it…" className={inp + ' resize-none'} />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-zinc-500"><span>How many nudges?</span><span className="font-medium text-zinc-700 dark:text-zinc-200">{count}</span></div>
          <input type="range" min={1} max={5} value={count} onChange={(e) => setCount(Number(e.target.value))} className="w-full accent-emerald-600" />
          <div className="mt-1.5 flex flex-wrap gap-1">{previewTimes(count).map((t) => <span key={t} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{t}</span>)}</div>
          <p className="mt-1 text-[10px] text-zinc-400">Spread over these times — any that have already passed today roll to the next day, until all {count} go out (or they reply).</p>
        </div>
        <button onClick={save} disabled={saving} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{reminder ? 'Save' : 'Create reminder'}</button>
      </div>
    </div>
  );
}
