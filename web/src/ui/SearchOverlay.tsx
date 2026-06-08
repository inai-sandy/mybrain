import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, FileText, Bookmark, MessageCircle, CornerDownLeft, Lightbulb } from 'lucide-react';

type Result = { title: string; snippet: string; type: string; itemId?: string; url?: string };

/** Global "search your brain" overlay — finds matching items AND offers to ask your brain.
 *  Open it with the header search box, a Home search, ⌘K / Ctrl+K, or window event 'open-search'. */
export function SearchOverlay() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(true); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('open-search', onOpen);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('open-search', onOpen); window.removeEventListener('keydown', onKey); };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 40);
    else { setQ(''); setResults([]); }
  }, [open]);

  useEffect(() => {
    if (!q.trim()) { setResults([]); setLoading(false); return; }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/chat/find?q=${encodeURIComponent(q)}`);
        if (r.ok) setResults((await r.json()).results || []);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  function openResult(r: Result) {
    setOpen(false);
    if (r.itemId) navigate(`/doc/${r.itemId}`);
    else if (r.url) window.open(r.url, '_blank');
  }
  function ask() {
    if (!q.trim()) return;
    setOpen(false);
    navigate(`/chat?q=${encodeURIComponent(q)}`);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-start justify-center p-3 sm:pt-24" onClick={() => setOpen(false)}>
      <div className="w-full sm:max-w-xl bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 border-b border-zinc-200 dark:border-zinc-800">
          <Search size={18} className="text-zinc-400 shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && results.length === 0) ask(); }}
            placeholder="Search your brain…"
            className="flex-1 bg-transparent py-3.5 text-sm outline-none placeholder:text-zinc-400"
          />
          <button onClick={() => setOpen(false)} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {q.trim() && (
            <button onClick={ask} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-left border-b border-zinc-100 dark:border-zinc-800">
              <MessageCircle size={16} className="text-emerald-500 shrink-0" />
              <span className="text-sm truncate">Ask your brain: <span className="font-medium">“{q}”</span></span>
              <CornerDownLeft size={13} className="ml-auto shrink-0 text-zinc-400" />
            </button>
          )}
          {loading && <div className="px-4 py-3 text-sm text-zinc-400">Searching…</div>}
          {!loading && q.trim() && results.length === 0 && <div className="px-4 py-6 text-sm text-zinc-400 text-center">No matching items — try “Ask your brain” above.</div>}
          {results.map((r, i) => {
            const Icon = r.type === 'bookmark' ? Bookmark : r.type === 'idea' ? Lightbulb : FileText;
            return (
              <button key={i} onClick={() => openResult(r)} className="w-full flex items-start gap-3 px-4 py-3 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-left">
                <Icon size={16} className={'mt-0.5 shrink-0 ' + (r.type === 'bookmark' ? 'text-emerald-500' : r.type === 'idea' ? 'text-amber-500' : 'text-sky-500')} />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{r.title}</div>
                  {r.snippet && <div className="text-xs text-zinc-400 line-clamp-1">{r.snippet}</div>}
                </div>
              </button>
            );
          })}
          {!q.trim() && <div className="px-4 py-6 text-sm text-zinc-400 text-center">Type to find your documents, bookmarks &amp; ideas — or ask your brain a question.</div>}
        </div>
      </div>
    </div>
  );
}

/** Anywhere: open the global search overlay. */
export function openSearch() {
  window.dispatchEvent(new Event('open-search'));
}
