import { useEffect, useState } from 'react';
import { Logo } from '../ui/Logo';
import { useParams } from 'react-router-dom';
import { Wand2, Download } from 'lucide-react';

type Shared = { title: string; description: string; platform: string; origin: string; downloadUrl: string | null; hasFile: boolean };

export function SkillViewer() {
  const { id } = useParams();
  const [d, setD] = useState<Shared | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/skill-share/${id}`)
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
          <Logo size={22} /> My Brain
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-5 py-8">
        {error && <p className="text-amber-500">{error}</p>}
        {d && (
          <>
            <div className="flex items-start gap-3">
              <div className="shrink-0 rounded-lg p-2.5 bg-violet-500/10 text-violet-500">
                <Wand2 size={20} />
              </div>
              <div className="min-w-0">
                <div className="text-xs text-zinc-400 capitalize">{d.origin} · {d.platform === 'chat' ? 'Claude Chat' : 'Claude Code'} skill</div>
                <h1 className="text-2xl font-extrabold tracking-tight">{d.title}</h1>
              </div>
            </div>
            {d.description && <p className="mt-4 border-l-4 border-violet-500 bg-violet-500/5 rounded-r-lg p-4 text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap">{d.description}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {d.hasFile && (
                <a href={`/api/skill-share/${id}/download`} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm">
                  <Download size={14} /> Download skill
                </a>
              )}
              {d.downloadUrl && (
                <a href={d.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 break-all">
                  <Download size={14} /> Open source link
                </a>
              )}
            </div>
          </>
        )}
        {!d && !error && <p className="text-zinc-400">Loading…</p>}
      </div>
    </div>
  );
}
