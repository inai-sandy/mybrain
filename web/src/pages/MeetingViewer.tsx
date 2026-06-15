import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Logo } from '../ui/Logo';
import { Mic, Clock, FileText, Lightbulb, Check, ListChecks } from 'lucide-react';

type Shared = {
  title: string;
  createdAt: string;
  durationSec: number;
  summary: string | null;
  takeaways: string[];
  decisions: string[];
  actionItems: any[];
};

function fmtDur(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}h ` : '') + `${m}m`;
}

export function MeetingViewer() {
  const { id } = useParams();
  const [d, setD] = useState<Shared | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/meeting-share/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setD)
      .catch(() => setError('This link is private or no longer shared.'));
  }, [id]);

  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur">
        <div className="max-w-2xl mx-auto px-5 h-12 flex items-center gap-2 font-bold">
          <Logo size={28} /> My Brain
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-5 py-8 space-y-5">
        {error && <p className="text-amber-500">{error}</p>}
        {d && (
          <>
            <div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400 mb-2">
                <span className="inline-flex items-center gap-1"><Mic size={12} className="text-emerald-500" /> {new Date(d.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                {d.durationSec > 0 && <span className="inline-flex items-center gap-1"><Clock size={12} /> {fmtDur(d.durationSec)}</span>}
              </div>
              <h1 className="text-2xl font-extrabold tracking-tight">{d.title}</h1>
            </div>

            {d.summary && (
              <Block icon={<FileText size={15} className="text-emerald-600" />} title="Summary">
                <p className="text-sm text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap">{d.summary}</p>
              </Block>
            )}
            {d.takeaways?.length > 0 && (
              <Block icon={<Lightbulb size={15} className="text-amber-500" />} title="Key takeaways">
                <ul className="list-disc pl-5 text-sm text-zinc-700 dark:text-zinc-200 space-y-1">{d.takeaways.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </Block>
            )}
            {d.decisions?.length > 0 && (
              <Block icon={<Check size={15} className="text-emerald-600" />} title="Decisions">
                <ul className="list-disc pl-5 text-sm text-zinc-700 dark:text-zinc-200 space-y-1">{d.decisions.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </Block>
            )}
            {d.actionItems?.length > 0 && (
              <Block icon={<ListChecks size={15} className="text-violet-500" />} title="Action items">
                <ul className="space-y-1 text-sm text-zinc-700 dark:text-zinc-200">{d.actionItems.map((t, i) => <li key={i} className="flex items-start gap-2"><span className="text-violet-400 mt-1">•</span> {typeof t === 'string' ? t : t.title}</li>)}</ul>
              </Block>
            )}
          </>
        )}
        {!d && !error && <p className="text-zinc-400">Loading…</p>}
      </div>
    </div>
  );
}

function Block({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <h2 className="flex items-center gap-2 font-semibold text-sm mb-2">{icon} {title}</h2>
      {children}
    </div>
  );
}
