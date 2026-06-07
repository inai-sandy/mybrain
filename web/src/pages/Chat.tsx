import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Plus, Send, X, ArrowLeft, ExternalLink, Sparkles, Trash2, Globe, Bookmark, Lightbulb, Activity as ActivityIcon, FileText, Wand2, Star, Search, Pin } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';

type Source = { title: string; url?: string; itemId?: string };
type Msg = { id: string; role: 'user' | 'assistant'; content: string; sources: Source[]; followups: string[]; starred: boolean; createdAt: string };
type Session = { id: string; title: string; scope: string; pinned: boolean; lastMessageAt: string | null; createdAt: string; messages: Msg[] };
type Starred = { id: string; messageId: string; sessionId: string | null; sessionTitle: string | null; scope: string; role: string; content: string; sources: Source[]; createdAt: string };

const SCOPES: { id: string; label: string; icon: any; hint: string }[] = [
  { id: 'everything', label: 'Everything', icon: Globe, hint: 'Your whole brain' },
  { id: 'bookmark', label: 'Bookmarks', icon: Bookmark, hint: 'Your saved links' },
  { id: 'idea', label: 'Ideas', icon: Lightbulb, hint: 'Your captured ideas' },
  { id: 'activity', label: 'Activity', icon: ActivityIcon, hint: 'Your days & story' },
  { id: 'document', label: 'Documents', icon: FileText, hint: 'Your research docs' },
  { id: 'skill', label: 'Skills', icon: Wand2, hint: 'Your Claude skills' },
];
const scopeOf = (id: string) => SCOPES.find((s) => s.id === id) || SCOPES[0];

const STARTERS: Record<string, string[]> = {
  everything: ['What did I save this week?', "Summarize what I've been working on", 'What ideas have I captured?'],
  bookmark: ['What did I save about SEO?', 'Show my AI / coding bookmarks', 'Any videos I saved on marketing?'],
  idea: ['What ideas have I had recently?', 'Which ideas still need research?', 'Summarize my best idea'],
  activity: ['What did I do yesterday?', 'How productive was my week?', 'What patterns do you see in my days?'],
  document: ['Summarize my latest research doc', 'What do my notes say about pricing?', 'Key takeaways from my documents'],
  skill: ['Which skills have I built?', "What does my deep-research skill do?", "Which skills am I not using?"],
};

function NewChatModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Session) => void }) {
  const toast = useToast();
  async function create(scope: string) {
    const r = await fetch('/api/chat/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }) });
    if (r.ok) onCreated(await r.json());
    else toast('error', 'Could not start chat');
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold">Talk to…</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
        </div>
        <p className="text-xs text-zinc-500 mb-3">Pick what this chat is about. It stays focused on that part of your memory.</p>
        <div className="grid grid-cols-2 gap-2">
          {SCOPES.map((s) => (
            <button key={s.id} onClick={() => create(s.id)} className="flex items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 text-left hover:border-emerald-500/50 hover:bg-emerald-500/5">
              <s.icon size={18} className="text-emerald-500 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">{s.label}</div>
                <div className="text-[11px] text-zinc-400 truncate">{s.hint}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SourceChip({ s }: { s: Source }) {
  const inner = (
    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-600 dark:text-zinc-300 hover:text-emerald-600">
      <ExternalLink size={10} /> {s.title}
    </span>
  );
  if (s.itemId) return <Link to={`/doc/${s.itemId}`}>{inner}</Link>;
  if (s.url) return <a href={s.url} target="_blank" rel="noopener noreferrer">{inner}</a>;
  return inner;
}

export function Chat() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  const [newChat, setNewChat] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [delFor, setDelFor] = useState<Session | null>(null);
  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');
  const [view, setView] = useState<'threads' | 'starred'>('threads');
  const [starred, setStarred] = useState<Starred[]>([]);
  const toast = useToast();
  const endRef = useRef<HTMLDivElement>(null);

  async function loadSessions(q = '') {
    const r = await fetch('/api/chat/sessions' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    if (r.ok) setSessions((await r.json()).sessions || []);
  }
  async function loadStarred() {
    const r = await fetch('/api/chat/starred');
    if (r.ok) setStarred((await r.json()).starred || []);
  }
  useEffect(() => {
    loadSessions();
  }, []);
  useEffect(() => {
    const t = setTimeout(() => loadSessions(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [active?.messages.length, sending]);

  async function openSession(id: string) {
    const r = await fetch(`/api/chat/sessions/${id}`);
    if (r.ok) setActive(await r.json());
  }

  async function send(text?: string) {
    const t = (text ?? input).trim();
    if (!t || !active || sending) return;
    setInput('');
    setSending(true);
    const optimistic: Msg = { id: 'tmp', role: 'user', content: t, sources: [], followups: [], starred: false, createdAt: new Date().toISOString() };
    setActive((a) => (a ? { ...a, messages: [...a.messages, optimistic] } : a));
    try {
      const r = await fetch(`/api/chat/sessions/${active.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) });
      if (r.ok) {
        const d = await r.json();
        setActive((a) => (a ? { ...a, title: a.title === 'New chat' ? t.slice(0, 60) : a.title, messages: [...a.messages.filter((m) => m.id !== 'tmp'), d.userMessage, d.message] } : a));
        loadSessions(search);
      } else toast('error', 'Could not get a reply');
    } catch {
      toast('error', 'Could not get a reply');
    } finally {
      setSending(false);
    }
  }

  async function remove(s: Session) {
    await fetch(`/api/chat/sessions/${s.id}`, { method: 'DELETE' });
    setDelFor(null);
    if (active?.id === s.id) setActive(null);
    loadSessions(search);
  }

  async function togglePin(s: Session, e: React.MouseEvent) {
    e.stopPropagation();
    await fetch(`/api/chat/sessions/${s.id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: !s.pinned }) });
    loadSessions(search);
  }

  async function toggleStar(m: Msg) {
    const on = !m.starred;
    const r = await fetch(`/api/chat/messages/${m.id}/star`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) });
    if (r.ok) setActive((a) => (a ? { ...a, messages: a.messages.map((x) => (x.id === m.id ? { ...x, starred: on } : x)) } : a));
    else toast('error', 'Could not star');
  }

  const visibleSessions = scopeFilter ? sessions.filter((s) => s.scope === scopeFilter) : sessions;

  // ---- list pane ----
  const listPane = (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-xl font-extrabold flex items-center gap-2"><MessageCircle className="text-emerald-500" size={22} /> Chat</h1>
        <button onClick={() => setNewChat(true)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1.5 text-sm"><Plus size={16} /> New</button>
      </div>

      {/* tabs: threads / starred */}
      <div className="flex gap-1 mb-2">
        <button onClick={() => setView('threads')} className={'flex-1 rounded-lg px-2 py-1 text-xs ' + (view === 'threads' ? 'bg-emerald-500/10 text-emerald-600 font-medium' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}>Threads</button>
        <button onClick={() => { setView('starred'); loadStarred(); }} className={'flex-1 inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ' + (view === 'starred' ? 'bg-amber-500/10 text-amber-600 font-medium' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}><Star size={12} /> Starred</button>
      </div>

      {view === 'threads' ? (
        <>
          <div className="space-y-2 mb-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-zinc-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500" />
            </div>
            <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)} className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 text-xs">
              <option value="">All scopes</option>
              {SCOPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div className="flex-1 overflow-y-auto space-y-1">
            {visibleSessions.length === 0 && <p className="text-sm text-zinc-400 p-4 text-center">No chats — tap “New” to talk to your brain.</p>}
            {visibleSessions.map((s) => {
              const sc = scopeOf(s.scope);
              return (
                <button key={s.id} onClick={() => openSession(s.id)} className={'group w-full text-left rounded-lg px-3 py-2 flex items-center gap-2 ' + (active?.id === s.id ? 'bg-emerald-500/10' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800')}>
                  <sc.icon size={15} className="text-zinc-400 shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-sm">{s.pinned && <Pin size={11} className="inline -mt-0.5 mr-1 text-emerald-500 fill-emerald-500" />}{s.title}</span>
                  <span className="text-[10px] text-zinc-400 shrink-0">{sc.label}</span>
                  <Pin size={13} onClick={(e) => togglePin(s, e)} className={'shrink-0 opacity-0 group-hover:opacity-100 hover:text-emerald-600 ' + (s.pinned ? 'text-emerald-500' : 'text-zinc-400')} />
                  <Trash2 size={13} onClick={(e) => { e.stopPropagation(); setDelFor(s); }} className="shrink-0 opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-rose-600" />
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-2">
          {starred.length === 0 && <p className="text-sm text-zinc-400 p-4 text-center">No starred messages yet. Tap the ⭐ on any message to keep it forever.</p>}
          {starred.map((s) => (
            <div key={s.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 mb-1">
                <Star size={11} className="text-amber-500 fill-amber-500" /> {scopeOf(s.scope).label}
                {s.sessionId && <button onClick={() => openSession(s.sessionId!)} className="ml-auto text-emerald-600 hover:underline">open chat</button>}
              </div>
              <p className="text-sm whitespace-pre-wrap line-clamp-6">{s.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // ---- conversation pane ----
  const sc = active ? scopeOf(active.scope) : null;
  const convoPane = active ? (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 pb-3 border-b border-zinc-200 dark:border-zinc-800">
        <button onClick={() => setActive(null)} className="md:hidden p-1 text-zinc-500"><ArrowLeft size={18} /></button>
        {sc && <sc.icon size={16} className="text-emerald-500" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate text-sm">{active.title}</div>
          <div className="text-[11px] text-zinc-400">Talking to {sc?.label}</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-4 space-y-4">
        {active.messages.length === 0 && (
          <div className="text-center text-sm text-zinc-400 mt-8">
            <Sparkles className="mx-auto mb-2 text-emerald-500" size={22} />
            <p className="mb-3">Ask anything about your {sc?.label.toLowerCase()}.</p>
            <div className="flex flex-col items-center gap-1.5">
              {(STARTERS[active.scope] || STARTERS.everything).map((p) => (
                <button key={p} onClick={() => send(p)} className="rounded-full border border-emerald-500/40 text-emerald-600 px-3 py-1 text-xs hover:bg-emerald-500/10">{p}</button>
              ))}
            </div>
          </div>
        )}
        {active.messages.map((m) => (
          <div key={m.id} className={'group flex ' + (m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm relative ' + (m.role === 'user' ? 'bg-emerald-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800')}>
              <div className="whitespace-pre-wrap leading-relaxed">{m.content}</div>
              {m.role === 'assistant' && m.sources?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">{m.sources.map((s, i) => <SourceChip key={i} s={s} />)}</div>
              )}
              {m.role === 'assistant' && m.followups?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.followups.map((f, i) => (
                    <button key={i} onClick={() => send(f)} className="rounded-full border border-emerald-500/40 text-emerald-600 px-2.5 py-0.5 text-[11px] hover:bg-emerald-500/10">{f}</button>
                  ))}
                </div>
              )}
              {m.id !== 'tmp' && (
                <button onClick={() => toggleStar(m)} title={m.starred ? 'Unstar' : 'Star this message'} className={'absolute -top-2 ' + (m.role === 'user' ? '-left-2' : '-right-2') + ' p-1 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 ' + (m.starred ? 'text-amber-500' : 'text-zinc-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100') + ' hover:text-amber-500'}>
                  <Star size={13} className={m.starred ? 'fill-amber-500' : ''} />
                </button>
              )}
            </div>
          </div>
        ))}
        {sending && <div className="flex justify-start"><div className="rounded-2xl bg-zinc-100 dark:bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-400">Thinking…</div></div>}
        <div ref={endRef} />
      </div>

      <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={1}
            placeholder={`Ask your ${sc?.label.toLowerCase()}…`}
            className="flex-1 resize-none rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2.5 text-sm outline-none focus:border-emerald-500 max-h-32"
          />
          <button onClick={() => send()} disabled={!input.trim() || sending} className="rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white p-2.5 disabled:opacity-40"><Send size={18} /></button>
        </div>
      </div>
    </div>
  ) : (
    <div className="hidden md:flex flex-col items-center justify-center h-full text-zinc-400">
      <MessageCircle size={40} className="mb-3" />
      <p className="text-sm">Pick a chat, or start a new one.</p>
    </div>
  );

  return (
    <div className="h-[calc(100vh-7rem)] md:h-[calc(100vh-6rem)]">
      <div className="grid md:grid-cols-[18rem_1fr] gap-4 h-full">
        <div className={'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 h-full ' + (active ? 'hidden md:block' : 'block')}>{listPane}</div>
        <div className={'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 h-full ' + (active ? 'block' : 'hidden md:block')}>{convoPane}</div>
      </div>

      {newChat && <NewChatModal onClose={() => setNewChat(false)} onCreated={(s) => { setNewChat(false); setSessions((p) => [s, ...p]); setActive(s); }} />}
      {delFor && <ConfirmDialog title="Delete chat?" message={`“${delFor.title}” will be removed.`} confirmLabel="Delete" onConfirm={() => remove(delFor)} onCancel={() => setDelFor(null)} />}
    </div>
  );
}
