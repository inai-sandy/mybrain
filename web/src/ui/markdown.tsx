import { useEffect, useState, type ReactNode } from 'react';
import { List, ChevronLeft } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

/** The one styling recipe for rendered AI markdown (bold, lists, headings, code, quotes). (BEA-885) */
const MD_PROSE =
  'break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2.5 [&_ul]:my-2.5 [&_ol]:my-2.5 [&_ul]:pl-5 [&_ol]:pl-5 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-1 [&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-4 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:mt-4 [&_h3]:font-semibold [&_h3]:mt-3 [&_pre]:rounded-lg [&_pre]:bg-zinc-100 dark:[&_pre]:bg-zinc-800/80 [&_pre]:p-3 [&_pre]:my-2.5 [&_pre]:text-xs [&_pre]:overflow-x-auto [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-zinc-100 dark:[&_:not(pre)>code]:bg-zinc-800 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:text-[12.5px] [&_a]:text-emerald-600 [&_a]:underline [&_strong]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 dark:[&_blockquote]:border-zinc-600 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-500';

/** Render AI-generated markdown consistently across the app. Drop-in for any prose field that was
 *  showing raw `**stars**` / `- dots`. Pass text-size/colour via className. (BEA-885) */
export function Markdown({ children, className = '' }: { children?: string | null; className?: string }) {
  return (
    <div className={`${MD_PROSE} ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{children || ''}</ReactMarkdown>
    </div>
  );
}

export const mdComponents = {
  h1: ({ children }: any) => <h1 id={slugify(nodeText(children))} className="scroll-mt-20">{children}</h1>,
  h2: ({ children }: any) => <h2 id={slugify(nodeText(children))} className="scroll-mt-20">{children}</h2>,
  h3: ({ children }: any) => <h3 id={slugify(nodeText(children))} className="scroll-mt-20">{children}</h3>,
  a: ({ href, children }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:underline break-words">{children}</a>
  ),
};

function TocList({ headings }: { headings: Heading[] }) {
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
  );
}

function usePersistedBool(key: string, def: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState<boolean>(() => {
    try {
      const s = localStorage.getItem(key);
      return s == null ? def : s === '1';
    } catch {
      return def;
    }
  });
  const set = (nv: boolean) => {
    setV(nv);
    try {
      localStorage.setItem(key, nv ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  return [v, set];
}

/**
 * Wraps article content with an optional "On this page" outline that collapses SIDEWAYS:
 * collapsed (default) → content is centered; expanded → outline rail on the left.
 * On mobile the outline is always a small accordion above the content.
 */
export function OutlineLayout({ headings, children }: { headings: Heading[]; children: ReactNode }) {
  const has = headings.length >= 2;
  const [open, setOpen] = usePersistedBool('toc.open', false);
  if (!has) return <div className="max-w-3xl mx-auto">{children}</div>;

  return (
    <div className={open ? 'lg:flex lg:gap-8' : ''}>
      {open && (
        <aside className="hidden lg:block lg:w-56 shrink-0 order-first">
          <div className="sticky top-20">
            <div className="flex items-center justify-between mb-2">
              <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                <List size={14} /> On this page
              </span>
              <button onClick={() => setOpen(false)} title="Hide outline" className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                <ChevronLeft size={16} />
              </button>
            </div>
            <TocList headings={headings} />
          </div>
        </aside>
      )}
      <div className={'min-w-0 ' + (open ? 'flex-1' : 'max-w-3xl mx-auto')}>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="hidden lg:inline-flex items-center gap-1.5 mb-4 text-sm text-zinc-500 hover:text-emerald-600 rounded-lg border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5"
          >
            <List size={15} /> On this page
          </button>
        )}
        <details className="lg:hidden mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
          <summary className="text-sm font-medium cursor-pointer text-zinc-600 dark:text-zinc-300">On this page</summary>
          <div className="mt-2">
            <TocList headings={headings} />
          </div>
        </details>
        {children}
      </div>
    </div>
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
