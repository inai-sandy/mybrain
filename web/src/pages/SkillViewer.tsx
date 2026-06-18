import { useEffect, useMemo, useState } from 'react';
import { Logo } from '../ui/Logo';
import { useParams } from 'react-router-dom';
import { Wand2, Download, Terminal, Copy, Check, FileText, ExternalLink } from 'lucide-react';

type Shared = {
  title: string;
  description: string;
  platform: string;
  origin: string;
  downloadUrl: string | null;
  hasFile: boolean;
  content: string | null;
  slug: string;
  isZip: boolean;
};

export function SkillViewer() {
  const { id } = useParams();
  const [d, setD] = useState<Shared | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/skill-share/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setD)
      .catch(() => setError('This link is private or no longer shared.'));
  }, [id]);

  // The one-click command a visitor runs on their own server to install the skill
  // straight into ~/.claude/skills/<slug>/.
  const command = useMemo(() => {
    if (!d || !d.hasFile) return '';
    const dl = `${window.location.origin}/api/skill-share/${id}/download`;
    const slug = d.slug || 'skill';
    return d.isZip
      ? `mkdir -p ~/.claude/skills/${slug} && curl -fsSL ${dl} -o /tmp/${slug}.zip && unzip -o /tmp/${slug}.zip -d ~/.claude/skills/${slug} && rm /tmp/${slug}.zip`
      : `mkdir -p ~/.claude/skills/${slug} && curl -fsSL ${dl} -o ~/.claude/skills/${slug}/SKILL.md`;
  }, [d, id]);

  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 md:bg-white/80 md:dark:bg-zinc-950/80 md:backdrop-blur">
        <div className="max-w-2xl mx-auto px-5 h-12 flex items-center gap-2 font-bold">
          <Logo size={28} /> My Brain
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

            {/* Install on your server — the one-click command */}
            {command && (
              <div className="mt-6 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <h2 className="flex items-center gap-2 font-semibold text-sm"><Terminal size={15} className="text-emerald-600" /> Install on your server</h2>
                  <button onClick={copyCmd} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs">
                    {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy command</>}
                  </button>
                </div>
                <p className="text-xs text-zinc-400 mb-2">Paste this into your server's terminal — it installs the skill into <code className="text-zinc-500">~/.claude/skills/{d.slug}</code>.</p>
                <pre className="whitespace-pre-wrap break-all text-xs text-zinc-700 dark:text-zinc-200 font-mono bg-white dark:bg-zinc-950 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">{command}</pre>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a href={`/api/skill-share/${id}/download`} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600">
                    <Download size={14} /> Or download the file
                  </a>
                  {d.downloadUrl && (
                    <a href={d.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 break-all">
                      <ExternalLink size={14} /> Source link
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* If there's nothing to download from us, at least surface the source link */}
            {!command && d.downloadUrl && (
              <div className="mt-6">
                <a href={d.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm break-all">
                  <ExternalLink size={14} /> Open source link
                </a>
              </div>
            )}

            {/* SKILL.md preview — see exactly what it does before installing */}
            {d.content && (
              <div className="mt-6">
                <h2 className="flex items-center gap-2 font-semibold text-sm mb-2"><FileText size={15} className="text-zinc-500" /> SKILL.md</h2>
                <pre className="whitespace-pre-wrap break-words text-xs text-zinc-700 dark:text-zinc-300 font-mono max-h-[28rem] overflow-auto bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">{d.content}</pre>
              </div>
            )}
          </>
        )}
        {!d && !error && <p className="text-zinc-400">Loading…</p>}
      </div>
    </div>
  );
}
