import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, MessageCircle, Send, Mic, Sparkles } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { DictateButton } from '../ui/DictateButton';
import { GrowTextarea } from '../ui/GrowTextarea';
import { Bubble, Msg } from './Chat';

type DocSession = { id: string; title: string; docTitle?: string; messages: Msg[] };

const STARTERS = ['Summarize this document', 'What are the key points?', 'What should I take away from this?'];

export function ChatDoc() {
  const { id } = useParams();
  const [session, setSession] = useState<DocSession | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const toast = useToast();
  const endRef = useRef<HTMLDivElement>(null);

  async function load() {
    const r = await fetch(`/api/chat/doc/${id}`);
    if (r.ok) setSession(await r.json());
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages.length, streaming, sending]);

  async function send(text?: string) {
    const t = (text ?? input).trim();
    if (!t || !session || sending) return;
    setInput('');
    setSending(true);
    setStreaming('');
    setSession((s) => (s ? { ...s, messages: [...s.messages, { id: 'tmp-u', role: 'user', content: t, sources: [], followups: [], starred: false, createdAt: '' }] } : s));
    try {
      const r = await fetch(`/api/chat/sessions/${session.id}/message/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) });
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
          } catch { /* ignore */ }
        }
      }
      if (finalMsg) setSession((s) => (s ? { ...s, messages: [...s.messages.filter((m) => m.id !== 'tmp-u'), finalUser!, finalMsg!] } : s));
      else toast('error', 'No reply');
    } catch {
      toast('error', 'Could not get a reply');
    } finally {
      setSending(false);
      setStreaming(null);
    }
  }

  return (
    <div className="space-y-3">
      <Link to={`/doc/${id}`} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={16} /> Back to document
      </Link>

      <div className="flex flex-col h-[calc(100vh-11rem)] rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <MessageCircle size={16} className="text-emerald-500 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{session?.docTitle || session?.title || 'Document'}</div>
            <div className="text-[11px] text-zinc-400">Answers come only from this document</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          <div className="max-w-3xl mx-auto w-full px-4 py-6 space-y-6">
            {session && session.messages.length === 0 && !streaming && (
              <div className="text-center text-sm text-zinc-400 mt-8">
                <Sparkles className="mx-auto mb-2 text-emerald-500" size={24} />
                <p className="mb-4 text-zinc-500">Ask anything about this document.</p>
                <div className="flex flex-col items-center gap-2">
                  {STARTERS.map((p) => <button key={p} onClick={() => send(p)} className="rounded-full border border-zinc-200 dark:border-zinc-700 px-4 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500/50 hover:text-emerald-600">{p}</button>)}
                </div>
              </div>
            )}
            {session?.messages.map((m) => <Bubble key={m.id} m={m} onFollow={send} />)}
            {streaming !== null && <Bubble m={{ id: 'tmp-a', role: 'assistant', content: streaming || '', sources: [], followups: [], starred: false, createdAt: '' }} />}
            <div ref={endRef} />
          </div>
        </div>

        <div className="border-t border-zinc-200 dark:border-zinc-800 shrink-0">
          <div className="max-w-3xl mx-auto w-full px-4 py-3">
            <div className="flex items-end gap-1.5 rounded-2xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 pl-3 pr-1.5 py-1 focus-within:border-emerald-500 transition-colors">
              <GrowTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                rows={1}
                placeholder="Ask about this document…"
                className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-zinc-400"
              />
              <DictateButton onText={(chunk) => setInput((i) => (i ? i + ' ' : '') + chunk)} className="shrink-0 mb-0.5" />
              <button onClick={() => send()} disabled={!input.trim() || sending} className="shrink-0 mb-0.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white p-2 disabled:opacity-40"><Send size={16} /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
