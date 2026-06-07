import { useEffect, useState } from 'react';
import { List } from 'lucide-react';

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function nodeText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (node?.props?.children) return nodeText(node.props.children);
  return '';
}

export function youtubeId(url: string): string | null {
  const m = (url || '').match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{6,})/i);
  return m ? m[1] : null;
}

export type Heading = { level: number; text: string; id: string };

export function extractHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (!m) continue;
    const text = m[2].replace(/[`*_]/g, '').trim();
    out.push({ level: m[1].length, text, id: slugify(text) || 'section' });
  }
  return out;
}

/** Drop a leading bare-URL line (bookmarks store the link on line 1) from the rendered body. */
export function stripLeadingUrl(md: string): string {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^https?:\/\/\S+$/.test(lines[i].trim())) lines.splice(0, i + 1);
  return lines.join('\n').replace(/^\n+/, '');
}

export const mdComponents = {
  h1: ({ children }: any) => <h1 id={slugify(nodeText(children))} className="scroll-mt-20">{children}</h1>,
  h2: ({ children }: any) => <h2 id={slugify(nodeText(children))} className="scroll-mt-20">{children}</h2>,
  h3: ({ children }: any) => <h3 id={slugify(nodeText(children))} className="scroll-mt-20">{children}</h3>,
  a: ({ href, children }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:underline break-words">{children}</a>
  ),
};

export function Toc({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState('');
  useEffect(() => {
    const els = headings.map((h) => document.getElementById(h.id)).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [headings]);

  return (
    <nav>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-2">
        <List size={14} /> On this page
      </div>
      <ul className="border-l border-zinc-200 dark:border-zinc-800">
        {headings.map((h, i) => (
          <li key={h.id + i}>
            <button
              onClick={() => document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className={
                'block w-full text-left -ml-px border-l-2 py-1 text-sm transition-colors ' +
                (active === h.id
                  ? 'border-emerald-500 text-emerald-600 font-medium'
                  : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200')
              }
              style={{ paddingLeft: (h.level - 1) * 12 + 12 }}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** YouTube embed or cover image for a doc, or null. */
export function MediaEmbed({ sourceUrl, source, thumbnail, title }: { sourceUrl?: string | null; source?: string; thumbnail?: string | null; title?: string }) {
  const ytId = sourceUrl ? youtubeId(sourceUrl) : null;
  if (ytId)
    return (
      <div className="aspect-video w-full rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
        <iframe
          className="w-full h-full"
          src={`https://www.youtube.com/embed/${ytId}`}
          title={title || 'video'}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  if (thumbnail && source === 'raindrop')
    return (
      <a href={sourceUrl || '#'} target="_blank" rel="noreferrer" className="block rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
        <img src={thumbnail} alt="" className="w-full max-h-80 object-cover" />
      </a>
    );
  return null;
}
