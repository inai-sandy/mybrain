import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageCircle, Plus, Send, X, ArrowLeft, ExternalLink, Sparkles, Trash2, Globe, Bookmark, Lightbulb, Activity as ActivityIcon, FileText, Wand2, Star, Search, Pin, PanelLeft, Copy, Check } from 'lucide-react';
import { Mic } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useDictation } from '../ui/useDictation';
import { GrowTextarea } from '../ui/GrowTextarea';
import { mdComponents } from '../ui/markdown';

export type Source = { title: string; url?: string; itemId?: string };
export type Msg = { id: string; role: 'user' | 'assistant'; content: string; sources: Source[]; followups: string[]; starred: boolean; createdAt: string };
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
  skill: ['Which skills have I built?', 'What does my deep-research skill do?', 'Which skills am I not using?'],
};

function NewChatModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Session) => void }) {
  const toast = useToast();
  async function create(scope: string) {
    const r = await fetch('/api/chat/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }) });
    if (r.ok) onCreated(await r.json());
    else toast('error', 'Could not start chat');
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
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
    <span className="inline-flex items-center gap-1 max-w-[70vw] md:max-w-[220px] rounded-full bg-zinc-200/70 dark:bg-zinc-700/60 px-2 py-0.5 text-[11px] text-zinc-600 dark:text-zinc-300 hover:text-emerald-600">
      <ExternalLink size={10} className="shrink-0" /> <span className="truncate">{s.title}</span>
    </span>
  );
  if (s.itemId) return <Link to={`/doc/${s.itemId}`}>{inner}</Link>;
  if (s.url) return <a href={s.url} target="_blank" rel="noopener noreferrer">{inner}</a>;
  return inner;
}

export function Bubble({ m, onStar, onFollow }: { m: Msg; onStar?: (m: Msg) => void; onFollow?: (q: string) => void }) {
  const user = m.role === 'user';
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ }
  }
  const temp = m.id === 'tmp-u' || m.id === 'tmp-a';
  return (
    <div className={'group ' + (user ? 'flex justify-end' : '')}>
      <div className={user ? 'max-w-[82%]' : 'w-full'}>
        {user ? (
          <div className="rounded-2xl rounded-br-md bg-emerald-600 text-white px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed break-words">{m.content}</div>
        ) : (
          <div className="text-[14px] leading-[1.7] text-zinc-800 dark:text-zinc-100 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2.5 [&_ul]:my-2.5 [&_ol]:my-2.5 [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-1 [&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-4 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:mt-4 [&_h3]:font-semibold [&_h3]:mt-3 [&_pre]:rounded-lg [&_pre]:bg-zinc-100 dark:[&_pre]:bg-zinc-800/80 [&_pre]:p-3 [&_pre]:my-2.5 [&_pre]:text-xs [&_pre]:overflow-x-auto [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-zinc-100 dark:[&_:not(pre)>code]:bg-zinc-800 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:text-[12.5px] [&_a]:text-emerald-600 [&_a]:underline [&_strong]:font-semibold">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.content || '…'}</ReactMarkdown>
          </div>
        )}
        {!user && m.sources?.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{m.sources.map((s, i) => <SourceChip key={i} s={s} />)}</div>}
        {!user && m.followups?.length > 0 && onFollow && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {m.followups.map((f, i) => <button key={i} onClick={() => onFollow(f)} className="rounded-full border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 px-3 py-1 text-xs hover:border-emerald-500/50 hover:text-emerald-600">{f}</button>)}
          </div>
        )}
        {onStar && !temp && (
          <div className={'mt-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ' + (user ? 'justify-end' : '')}>
            {!user && <button onClick={copy} title="Copy" className="p-1 rounded text-zinc-400 hover:text-emerald-600 hover:bg-zinc-100 dark:hover:bg-zinc-800">{copied ? <Check size={13} /> : <Copy size={13} />}</button>}
            <button onClick={() => onStar(m)} title={m.starred ? 'Unstar' : 'Star this message'} className={'p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (m.starred ? 'text-amber-500' : 'text-zinc-400 hover:text-amber-500')}><Star size={13} className={m.starred ? 'fill-amber-500' : ''} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Chat() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  const [newChat, setNewChat] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [delFor, setDelFor] = useState<Session | null>(null);
  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');
  const [view, setView] = useState<'threads' | 'starred'>('threads');
  const [starred, setStarred] = useState<Starred[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const toast = useToast();
  const endRef = useRef<HTMLDivElement>(null);
  const { supported: micOk, listening, toggle: toggleMic } = useDictation((chunk) => setInput((i) => (i ? i + ' ' : '') + chunk));
  const [params, setParams] = useSearchParams();
  const pendingRef = useRef<string | null>(null);

  // Arriving from search with ?q= → start a fresh "everything" chat and ask it.
  useEffect(() => {
    const qq = params.get('q');
    if (!qq) return;
    setParams({}, { replace: true });
    (async () => {
      const r = await fetch('/api/chat/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'everything' }) });
      if (r.ok) {
        const s = await r.json();
        setSessions((p) => [s, ...p]);
        pendingRef.current = qq;
        setActive(s);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (active && pendingRef.current) {
      const qq = pendingRef.current;
      pendingRef.current = null;
      send(qq);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function loadSessions(q = '') {
    const r = await fetch('/api/chat/sessions' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    if (r.ok) setSessions((await r.json()).sessions || []);
  }
  async function loadStarred() {
    const r = await fetch('/api/chat/starred');
    if (r.ok) setStarred((await r.json()).starred || []);
  }
  useEffect(() => { loadSessions(); }, []);
  useEffect(() => { const t = setTimeout(() => loadSessions(search), 250); return () => clearTimeout(t); }, [search]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [active?.messages.length, streaming, sending]);

  async function openSession(id: string) {
    const r = await fetch(`/api/chat/sessions/${id}`);
    if (r.ok) setActive(await r.json());
  }

  async function send(text?: string) {
    const t = (text ?? input).trim();
    if (!t || !active || sending) return;
    setInput('');
    setSending(true);
    setStreaming('');
    setActive((a) => (a ? { ...a, messages: [...a.messages, { id: 'tmp-u', role: 'user', content: t, sources: [], followups: [], starred: false, createdAt: new Date().toISOString() }] } : a));
    try {
      const r = await fetch(`/api/chat/sessions/${active.id}/message/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) });
      if (!r.ok || !r.body) throw new Error('no stream');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let acc = '';
      let finalMsg: Msg | null = null;
      let finalUser: Msg | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop() || '';
        for (const b of blocks) {
          const line = b.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.token) { acc += j.token; setStreaming(acc.split('FOLLOWUPS:')[0]); }
            else if (j.done) { finalMsg = j.message; finalUser = j.userMessage; }
            else if (j.error) toast('error', j.error);
          } catch { /* ignore */ }
        }
      }
      if (finalMsg) {
        setActive((a) => (a ? { ...a, title: a.title === 'New chat' ? t.slice(0, 60) : a.title, messages: [...a.messages.filter((m) => m.id !== 'tmp-u'), finalUser!, finalMsg!] } : a));
        loadSessions(search);
      } else {
        toast('error', 'No reply');
      }
    } catch {
      toast('error', 'Could not get a reply');
    } finally {
      setSending(false);
      setStreaming(null);
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
  }

  const visibleSessions = scopeFilter ? sessions.filter((s) => s.scope === scopeFilter) : sessions;
  const sc = active ? scopeOf(active.scope) : null;

  const listContent = (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-2 shrink-0">
        <h1 className="text-lg font-extrabold flex items-center gap-2"><MessageCircle className="text-emerald-500" size={20} /> Chat</h1>
        <button onClick={() => setNewChat(true)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1.5 text-sm"><Plus size={16} /> New</button>
      </div>
      <div className="flex gap-1 mb-2 shrink-0">
        <button onClick={() => setView('threads')} className={'flex-1 rounded-lg px-2 py-1 text-xs ' + (view === 'threads' ? 'bg-emerald-500/10 text-emerald-600 font-medium' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}>Threads</button>
        <button onClick={() => { setView('starred'); loadStarred(); }} className={'flex-1 inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs ' + (view === 'starred' ? 'bg-amber-500/10 text-amber-600 font-medium' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}><Star size={12} /> Starred</button>
      </div>
      {view === 'threads' ? (
        <>
          <div className="space-y-2 mb-2 shrink-0">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-2.5 text-zinc-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500" />
            </div>
            <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)} className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 text-xs">
              <option value="">All scopes</option>
              {SCOPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 space-y-1 -mr-1 pr-1">
            {visibleSessions.length === 0 && <p className="text-sm text-zinc-400 p-4 text-center">No chats — tap “New”.</p>}
            {visibleSessions.map((s) => {
              const ss = scopeOf(s.scope);
              return (
                <button key={s.id} onClick={() => openSession(s.id)} className={'group w-full text-left rounded-lg px-3 py-2 flex items-center gap-2 ' + (active?.id === s.id ? 'bg-emerald-500/10' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800')}>
                  <ss.icon size={15} className="text-zinc-400 shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-sm">{s.pinned && <Pin size={11} className="inline -mt-0.5 mr-1 text-emerald-500 fill-emerald-500" />}{s.title}</span>
                  <Pin size={13} onClick={(e) => togglePin(s, e)} className={'shrink-0 opacity-0 group-hover:opacity-100 hover:text-emerald-600 ' + (s.pinned ? 'text-emerald-500' : 'text-zinc-400')} />
                  <Trash2 size={13} onClick={(e) => { e.stopPropagation(); setDelFor(s); }} className="shrink-0 opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-rose-600" />
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0 space-y-2 -mr-1 pr-1">
          {starred.length === 0 && <p className="text-sm text-zinc-400 p-4 text-center">No starred messages yet. Tap the ⭐ on any reply.</p>}
          {starred.map((s) => (
            <div key={s.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 mb-1">
                <Star size={11} className="text-amber-500 fill-amber-500" /> {scopeOf(s.scope).label}
                {s.sessionId && <button onClick={() => openSession(s.sessionId!)} className="ml-auto text-emerald-600 hover:underline">open</button>}
              </div>
              <p className="text-sm whitespace-pre-wrap line-clamp-6">{s.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const convo = active ? (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <button onClick={() => setActive(null)} className="md:hidden p-1 -ml-1 text-zinc-500"><ArrowLeft size={18} /></button>
        <button onClick={() => setSidebarOpen((v) => !v)} title="Toggle sidebar" className="hidden md:inline-flex p-1 text-zinc-400 hover:text-emerald-600"><PanelLeft size={18} /></button>
        {sc && <sc.icon size={16} className="text-emerald-500 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate text-sm">{active.title}</div>
          <div className="text-[11px] text-zinc-400">Talking to {sc?.label}</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        <div className="max-w-3xl mx-auto w-full px-4 py-6 space-y-6">
          {active.messages.length === 0 && !streaming && (
            <div className="text-center text-sm text-zinc-400 mt-10">
              <Sparkles className="mx-auto mb-2 text-emerald-500" size={24} />
              <p className="mb-4 text-zinc-500">Ask anything about your {sc?.label.toLowerCase()}.</p>
              <div className="flex flex-col items-center gap-2">
                {(STARTERS[active.scope] || STARTERS.everything).map((p) => (
                  <button key={p} onClick={() => send(p)} className="rounded-full border border-zinc-200 dark:border-zinc-700 px-4 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500/50 hover:text-emerald-600">{p}</button>
                ))}
              </div>
            </div>
          )}
          {active.messages.map((m) => <Bubble key={m.id} m={m} onStar={toggleStar} onFollow={send} />)}
          {streaming !== null && (
            <Bubble m={{ id: 'tmp-a', role: 'assistant', content: streaming || '', sources: [], followups: [], starred: false, createdAt: '' }} />
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-zinc-200 dark:border-zinc-800 shrink-0 [padding-bottom:env(safe-area-inset-bottom)] bg-white dark:bg-zinc-900">
        <div className="max-w-3xl mx-auto w-full px-4 py-3">
          <div className="flex items-end gap-1.5 rounded-2xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 pl-3 pr-1.5 py-1 focus-within:border-emerald-500 transition-colors">
            <GrowTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={1}
              placeholder={`Ask your ${sc?.label.toLowerCase()}…`}
              className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-zinc-400"
            />
            {micOk && (
              <button onClick={toggleMic} title={listening ? 'Stop' : 'Speak'} className={'shrink-0 mb-0.5 p-2 rounded-xl ' + (listening ? 'bg-rose-500 text-white animate-pulse' : 'text-zinc-400 hover:text-emerald-600')}><Mic size={16} /></button>
            )}
            <button onClick={() => send()} disabled={!input.trim() || sending} className="shrink-0 mb-0.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white p-2 disabled:opacity-40"><Send size={16} /></button>
          </div>
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
    <div className="h-full flex bg-white dark:bg-zinc-900 overflow-hidden">
      {/* Desktop collapsible sidebar */}
      <aside className={'hidden md:flex flex-col h-full shrink-0 overflow-hidden transition-[width] duration-200 bg-zinc-50 dark:bg-zinc-950 ' + (sidebarOpen ? 'w-72 border-r border-zinc-200 dark:border-zinc-800 p-3' : 'w-0')}>
        {sidebarOpen && listContent}
      </aside>

      {/* Main area — in-flow (no fixed overlay), fits between the top bar and bottom tabs */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {/* Mobile thread list (only when no conversation is open) */}
        {!active && <div className="md:hidden h-full min-h-0 p-3">{listContent}</div>}
        {/* Conversation — desktop always shows this column; mobile shows it only when a chat is open */}
        <div className={'h-full min-h-0 ' + (active ? 'flex flex-col' : 'hidden md:flex md:flex-col')}>{convo}</div>
      </div>

      {newChat && <NewChatModal onClose={() => setNewChat(false)} onCreated={(s) => { setNewChat(false); setSessions((p) => [s, ...p]); setActive(s); }} />}
      {delFor && <ConfirmDialog title="Delete chat?" message={`“${delFor.title}” will be removed.`} confirmLabel="Delete" onConfirm={() => remove(delFor)} onCancel={() => setDelFor(null)} />}
    </div>
  );
}
