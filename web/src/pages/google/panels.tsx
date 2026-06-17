import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Search, Download, Check, Loader2, RefreshCw, ExternalLink, FileText, Clock, Circle, Video, Copy, FilePlus2, Phone, Mail, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Sparkles, Inbox } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useToast } from '../../ui/Toast';
import { mdComponents } from '../../ui/markdown';
import { RequestsSection } from './GmailRequests';

export function fmtWhen(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const dateOnly = iso.length <= 10;
  return d.toLocaleString(undefined, dateOnly ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fileKind(mt: string) {
  if (mt.includes('document')) return 'Doc';
  if (mt.includes('spreadsheet')) return 'Sheet';
  if (mt.includes('presentation')) return 'Slides';
  if (mt.includes('pdf')) return 'PDF';
  if (mt.includes('folder')) return 'Folder';
  return mt.split('/').pop() || 'File';
}

type Email = { id: string; from: string; subject: string; date: string; snippet: string };
type DriveFile = { id: string; name: string; mimeType: string; modified: string; link: string };
type Event = { id: string; summary: string; start: string | null; end: string | null; location: string | null; link: string | null };
type TaskList = { listId: string; title: string; tasks: { id: string; title: string; due: string | null; notes: string | null }[] };
type Form = { id: string; name: string; modified: string; link: string };
type ChatSpace = { id: string; name: string; type: string };
type Contact = { name: string; email: string | null; phone: string | null };

// ---- Gmail: the Daily Brief (per-day unread + AI summary of important emails) ----
type BriefSection = { heading: string; points: string[]; link: string | null };
type Brief = { day: string; unread: number | null; overview: string; summary: string | null; sections: BriefSection[]; items: { from: string; subject: string; time: string }[]; generated: boolean; generatedAt: string | null };

function addDays(day: string, n: number): string {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  return new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function hhmm(t: string): string {
  const d = new Date(t);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function GmailPanel() {
  return (
    <div className="space-y-4">
      <DailyBriefCard />
      <RequestsSection />
    </div>
  );
}

/** Brief body (summary + email list), collapsed to ~30% of the screen with a fade + Expand/Show-less.
 *  The collapsed height is a FIXED pixel value frozen at mount (≈30% of the initial viewport). We do
 *  NOT use `vh` or a window-resize listener: on mobile, scrolling shows/hides the URL bar (changing the
 *  viewport height), which with `vh`/resize would re-clamp + reflow mid-scroll and make the page stick. */
function CollapsibleBrief({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [needsToggle, setNeedsToggle] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Frozen once: stable while scrolling regardless of the mobile URL-bar collapse.
  const [capPx] = useState(() => Math.max(200, Math.round((typeof window !== 'undefined' ? window.innerHeight : 760) * 0.3)));

  useEffect(() => {
    // scrollHeight is the full content height in both collapsed + expanded states (overflow:hidden
    // clips clientHeight, not scrollHeight), so comparing it to the fixed cap is stable either way.
    const el = ref.current;
    if (el) setNeedsToggle(el.scrollHeight > capPx + 8);
  }); // re-measure on render (content changes) — cheap, no resize listener, no vh.

  const clamp = !expanded && needsToggle;

  return (
    <div>
      <div ref={ref} style={clamp ? { maxHeight: capPx } : undefined} className={'relative ' + (clamp ? 'overflow-hidden' : '')}>
        {children}
        {clamp && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-white dark:from-zinc-900 to-transparent" />}
      </div>
      {needsToggle && (
        <button onClick={() => setExpanded((v) => !v)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-500">
          {expanded ? <><ChevronUp size={14} /> Show less</> : <><ChevronDown size={14} /> Expand</>}
        </button>
      )}
    </div>
  );
}

/** One topic of the Daily Brief as a collapsible card (collapsed by default) with an Open-in-Gmail link. */
function BriefSectionCard({ section }: { section: BriefSection }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-950/40 overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-zinc-100/60 dark:hover:bg-zinc-900/60">
        <ChevronRight size={15} className={'shrink-0 text-zinc-400 transition-transform ' + (open ? 'rotate-90' : '')} />
        <span className="flex-1 text-sm font-bold text-zinc-900 dark:text-zinc-100">{section.heading}</span>
        {!open && <span className="shrink-0 text-[11px] text-zinc-400">{section.points.length}</span>}
      </button>
      {open && (
        <div className="px-3 pb-3 pl-9">
          <article className="prose prose-sm prose-zinc dark:prose-invert max-w-none prose-strong:font-semibold prose-strong:text-zinc-900 dark:prose-strong:text-zinc-100 prose-ul:my-0 prose-ul:pl-4 prose-li:my-0.5 prose-li:marker:text-emerald-500">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{section.points.map((p) => `- ${p}`).join('\n')}</ReactMarkdown>
          </article>
          {section.link && (
            <a href={section.link} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 hover:text-emerald-600">
              <ExternalLink size={12} /> Open in Gmail
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function DailyBriefCard() {
  const [today, setToday] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const toast = useToast();

  async function loadDay(target?: string) {
    setLoading(true);
    setBrief(null);
    try {
      const r = await fetch('/api/google/gmail/brief' + (target ? `?day=${target}` : ''));
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load your brief');
      setDay(d.day);
      if (!target) setToday(d.day); // first load with no arg → server's "today"
      setBrief(d);
      // On "today" with no brief yet, build it now (first-open backfill). Past days stay on-demand.
      const isTodayTarget = !target || target === today;
      if (!d.generated && isTodayTarget) generate(d.day, true);
    } catch (e: any) {
      toast('error', e.message || 'Could not load your brief');
    } finally {
      setLoading(false);
    }
  }

  async function generate(target: string, auto = false) {
    setGenerating(true);
    try {
      const r = await fetch('/api/google/gmail/brief/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day: target }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not build your brief');
      setBrief(d);
      setDay(d.day);
      if (!auto) toast('success', 'Brief updated');
    } catch (e: any) {
      toast('error', e.message || 'Could not build your brief');
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    loadDay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isToday = !!day && !!today && day >= today;
  const canPrev = !!day;

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      {/* Day navigator */}
      <div className="flex items-center justify-between mb-3">
        <button onClick={() => day && loadDay(addDays(day, -1))} disabled={!canPrev || loading} className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 disabled:opacity-40" aria-label="Previous day">
          <ChevronLeft size={16} />
        </button>
        <div className="text-center">
          <div className="text-sm font-bold">{day && today ? dayLabel(day, today) : '…'}</div>
          {brief?.unread != null && <div className="text-[11px] text-zinc-400">{brief.unread} unread email{brief.unread === 1 ? '' : 's'} that day</div>}
        </div>
        <button onClick={() => day && !isToday && loadDay(addDays(day, 1))} disabled={isToday || loading} className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 disabled:opacity-40" aria-label="Next day">
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Brief body */}
      {loading ? (
        <div className="py-8 text-center text-sm text-zinc-400"><Loader2 size={18} className="animate-spin inline mr-2" /> Loading…</div>
      ) : generating ? (
        <div className="py-8 text-center text-sm text-zinc-500"><Sparkles size={18} className="inline mr-2 text-emerald-500" /> Writing your brief… this takes a moment.</div>
      ) : brief?.summary ? (
        <>
          <div className="flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-600"><Sparkles size={13} /> Daily brief</div>

          {brief.sections && brief.sections.length > 0 ? (
            <>
              {brief.overview && <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-3">{brief.overview}</p>}
              <div className="space-y-2">
                {brief.sections.map((s, i) => <BriefSectionCard key={i} section={s} />)}
              </div>
            </>
          ) : (
            // Fallback for briefs written before structured sections existed.
            <CollapsibleBrief>
              <article className="prose prose-sm prose-zinc dark:prose-invert max-w-none prose-headings:font-bold prose-strong:font-semibold prose-p:my-1.5 prose-ul:my-1.5 prose-ul:pl-4 prose-li:my-0.5 prose-li:marker:text-emerald-500">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{brief.summary}</ReactMarkdown>
              </article>
            </CollapsibleBrief>
          )}

          {brief.items.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-1.5 flex items-center gap-1"><Inbox size={12} /> Important emails ({brief.items.length})</div>
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {brief.items.map((it, i) => (
                  <li key={i} className="flex items-start gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{it.subject}</div>
                      <div className="text-[11px] text-zinc-400 truncate">{it.from}</div>
                    </div>
                    {hhmm(it.time) && <span className="shrink-0 text-[11px] text-zinc-400 tabular-nums">{hhmm(it.time)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between">
            {brief.generatedAt && <span className="text-[11px] text-zinc-400">Updated {new Date(brief.generatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
            <button onClick={() => day && generate(day)} disabled={generating} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 disabled:opacity-50">
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </>
      ) : (
        <div className="py-6 text-center">
          <p className="text-sm text-zinc-400 mb-3">No brief was written for this day.</p>
          <button onClick={() => day && generate(day)} disabled={generating} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
            <Sparkles size={14} /> Write the brief
          </button>
        </div>
      )}
    </section>
  );
}

// ---- Drive ----
export function DrivePanel() {
  const [dq, setDq] = useState('');
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [dLoading, setDLoading] = useState(false);
  const [importing, setImporting] = useState<Record<string, boolean>>({});
  const [imported, setImported] = useState<Record<string, boolean>>({});
  const toast = useToast();

  async function loadFiles() {
    setDLoading(true);
    try {
      const r = await fetch('/api/google/drive' + (dq.trim() ? `?q=${encodeURIComponent(dq.trim())}` : ''));
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load files');
      setFiles(d.files || []);
    } catch (e: any) {
      toast('error', e.message || 'Could not load files');
    } finally {
      setDLoading(false);
    }
  }

  async function importFile(id: string) {
    setImporting((p) => ({ ...p, [id]: true }));
    try {
      const r = await fetch(`/api/google/drive/${id}/import`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'Could not import');
      setImported((p) => ({ ...p, [id]: true }));
      toast('success', 'Imported to Capture');
    } catch (e: any) {
      toast('error', e.message || 'Could not import');
    } finally {
      setImporting((p) => ({ ...p, [id]: false }));
    }
  }

  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-400" />
          <input
            value={dq}
            onChange={(e) => setDq(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadFiles()}
            placeholder="Search Drive by file name…"
            className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
        </div>
        <button onClick={loadFiles} disabled={dLoading} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm disabled:opacity-50">
          {dLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Load
        </button>
      </div>
      {files === null ? (
        <p className="text-sm text-zinc-400">Tap <b>Load</b> to list your recent Drive files.</p>
      ) : files.length ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 py-2.5">
              <FileText size={14} className="shrink-0 text-zinc-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{f.name}</div>
                <div className="text-[11px] text-zinc-400">{fileKind(f.mimeType)}{f.modified ? ` · ${new Date(f.modified).toLocaleDateString()}` : ''}</div>
              </div>
              {f.link && <a href={f.link} target="_blank" rel="noreferrer" title="Open in Drive" className="shrink-0 p-1 text-zinc-400 hover:text-emerald-600"><ExternalLink size={14} /></a>}
              <button onClick={() => importFile(f.id)} disabled={importing[f.id] || imported[f.id]} className={'shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] disabled:opacity-60 ' + (imported[f.id] ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500 hover:text-emerald-600')}>
                {importing[f.id] ? <Loader2 size={11} className="animate-spin" /> : imported[f.id] ? <><Check size={11} /> Saved</> : <><Download size={11} /> Import</>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-400">No files found.</p>
      )}
    </section>
  );
}

// ---- Create a new Doc / Sheet / Slides (one panel, fixed type) ----
function CreatePanel({ type }: { type: 'doc' | 'sheet' | 'slides' }) {
  const [docTitle, setDocTitle] = useState('');
  const [docBody, setDocBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdLink, setCreatedLink] = useState('');
  const toast = useToast();
  const label = type === 'doc' ? 'Doc' : type === 'sheet' ? 'Sheet' : 'Slides';

  async function createFile() {
    if (!docTitle.trim() && !(type === 'doc' && docBody.trim())) return;
    setCreating(true);
    setCreatedLink('');
    try {
      const ep = type === 'doc' ? '/api/google/docs/create' : type === 'sheet' ? '/api/google/sheets/create' : '/api/google/slides/create';
      const payload = type === 'doc' ? { title: docTitle, content: docBody } : { title: docTitle };
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not create');
      setCreatedLink(d.link);
      toast('success', `${label} created`);
    } catch (e: any) {
      toast('error', e.message || 'Could not create');
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <p className="text-xs text-zinc-500 mb-3">Make a brand-new Google {label}. (Only creates new files — never edits or deletes your existing Drive.)</p>
      <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder={`${label} title`} className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500 mb-2" />
      {type === 'doc' && <textarea value={docBody} onChange={(e) => setDocBody(e.target.value)} rows={5} placeholder="Content (optional)…" className="w-full resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500" />}
      <div className="mt-3 flex items-center gap-3">
        <button onClick={createFile} disabled={creating || (!docTitle.trim() && !(type === 'doc' && docBody.trim()))} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
          {creating ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><FilePlus2 size={14} /> Create {label}</>}
        </button>
        {createdLink && <a href={createdLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-emerald-600 hover:underline">Open it <ExternalLink size={13} /></a>}
      </div>
    </section>
  );
}

export const DocsPanel = () => <CreatePanel type="doc" />;
export const SheetsPanel = () => <CreatePanel type="sheet" />;
export const SlidesPanel = () => <CreatePanel type="slides" />;

// ---- Calendar ----
export function CalendarPanel() {
  const [events, setEvents] = useState<Event[] | null>(null);
  const toast = useToast();
  useEffect(() => {
    fetch('/api/google/calendar').then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => setEvents(d.events || [])).catch(() => { setEvents([]); toast('error', 'Could not load your calendar'); });
  }, []);
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      {events === null ? (
        <p className="text-sm text-zinc-400">Loading your calendar…</p>
      ) : events.length ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {events.map((e) => (
            <li key={e.id} className="flex items-start gap-3 py-2">
              <span className="shrink-0 w-28 text-[11px] text-zinc-400 tabular-nums inline-flex items-center gap-1"><Clock size={11} /> {fmtWhen(e.start)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{e.summary}</div>
                {e.location && <div className="text-[11px] text-zinc-400 truncate">{e.location}</div>}
              </div>
              {e.link && <a href={e.link} target="_blank" rel="noreferrer" className="shrink-0 p-1 text-zinc-400 hover:text-emerald-600"><ExternalLink size={13} /></a>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-400">Nothing on your calendar coming up.</p>
      )}
    </section>
  );
}

// ---- Google Tasks ----
export function TasksPanel() {
  const [taskLists, setTaskLists] = useState<TaskList[] | null>(null);
  const [doneTasks, setDoneTasks] = useState<Record<string, boolean>>({});
  const toast = useToast();
  useEffect(() => {
    fetch('/api/google/tasks').then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => setTaskLists(d.lists || [])).catch(() => { setTaskLists([]); toast('error', 'Could not load your tasks'); });
  }, []);
  async function completeTask(listId: string, taskId: string) {
    setDoneTasks((p) => ({ ...p, [taskId]: true }));
    const r = await fetch(`/api/google/tasks/${listId}/${taskId}/complete`, { method: 'POST' });
    if (r.ok) toast('success', 'Marked done in Google Tasks');
    else {
      setDoneTasks((p) => ({ ...p, [taskId]: false }));
      toast('error', 'Could not update the task');
    }
  }
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      {taskLists === null ? (
        <p className="text-sm text-zinc-400">Loading your tasks…</p>
      ) : taskLists.some((l) => l.tasks.length) ? (
        <div className="space-y-4">
          {taskLists.filter((l) => l.tasks.length).map((l) => (
            <div key={l.listId}>
              <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">{l.title}</div>
              <ul className="space-y-1">
                {l.tasks.map((t) => {
                  const done = doneTasks[t.id];
                  return (
                    <li key={t.id} className="flex items-start gap-2 text-sm">
                      <button onClick={() => completeTask(l.listId, t.id)} disabled={done} className="mt-0.5 shrink-0 text-zinc-300 dark:text-zinc-600 hover:text-emerald-600 disabled:text-emerald-600">
                        {done ? <Check size={16} /> : <Circle size={16} />}
                      </button>
                      <div className="min-w-0">
                        <span className={done ? 'line-through text-zinc-400' : ''}>{t.title}</span>
                        {t.due && <span className="ml-2 text-[11px] text-zinc-400">due {fmtWhen(t.due)}</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-zinc-400">No open tasks. 🎉</p>
      )}
    </section>
  );
}

// ---- Meet ----
export function MeetPanel() {
  const [meetLink, setMeetLink] = useState('');
  const [creatingMeet, setCreatingMeet] = useState(false);
  const toast = useToast();
  async function createMeet() {
    setCreatingMeet(true);
    setMeetLink('');
    try {
      const r = await fetch('/api/google/meet/create', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not create a Meet');
      setMeetLink(d.uri || '');
      toast('success', 'Meet link created');
    } catch (e: any) {
      toast('error', e.message || 'Could not create a Meet');
    } finally {
      setCreatingMeet(false);
    }
  }
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <p className="text-xs text-zinc-500 mb-3">Spin up a fresh meeting link in one tap.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={createMeet} disabled={creatingMeet} className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 text-sm disabled:opacity-50">
          {creatingMeet ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><Video size={14} /> Create a Meet link</>}
        </button>
        {meetLink && (
          <span className="inline-flex items-center gap-2 text-sm">
            <a href={meetLink} target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline break-all">{meetLink.replace(/^https?:\/\//, '')}</a>
            <button onClick={() => { navigator.clipboard?.writeText(meetLink); toast('success', 'Copied'); }} title="Copy" className="p-1 text-zinc-400 hover:text-emerald-600"><Copy size={13} /></button>
          </span>
        )}
      </div>
    </section>
  );
}

// ---- Forms ----
export function FormsPanel() {
  const [forms, setForms] = useState<Form[] | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  async function load() {
    setLoading(true);
    try {
      const r = await fetch('/api/google/forms');
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load forms');
      setForms(d.forms || []);
    } catch (e: any) {
      toast('error', e.message || 'Could not load forms');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-end mb-3">
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 disabled:opacity-50">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>
      {forms === null ? (
        <p className="text-sm text-zinc-400">Loading your forms…</p>
      ) : forms.length ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {forms.map((f) => (
            <li key={f.id} className="flex items-center gap-2 py-2.5">
              <FileText size={14} className="shrink-0 text-zinc-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{f.name}</div>
                {f.modified && <div className="text-[11px] text-zinc-400">{new Date(f.modified).toLocaleDateString()}</div>}
              </div>
              <a href={f.link} target="_blank" rel="noreferrer" title="Open form" className="shrink-0 p-1 text-zinc-400 hover:text-emerald-600"><ExternalLink size={14} /></a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-400">No forms yet. When you create Google Forms they’ll show up here.</p>
      )}
    </section>
  );
}

// ---- Chat ----
export function ChatPanel() {
  const [spaces, setSpaces] = useState<ChatSpace[] | null>(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  async function load() {
    setLoading(true);
    try {
      const r = await fetch('/api/google/chat');
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load Chat');
      setSpaces(d.spaces || []);
      setNote(d.available === false ? d.note || '' : '');
    } catch (e: any) {
      toast('error', e.message || 'Could not load Chat');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-end mb-3">
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 disabled:opacity-50">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>
      {spaces === null ? (
        <p className="text-sm text-zinc-400">Loading your Chat spaces…</p>
      ) : spaces.length ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {spaces.map((s) => (
            <li key={s.id} className="flex items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{s.name}</div>
                <div className="text-[11px] text-zinc-400 capitalize">{String(s.type).replace(/_/g, ' ').toLowerCase()}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : note ? (
        <p className="text-sm text-zinc-400">{note}</p>
      ) : (
        <p className="text-sm text-zinc-400">No Chat spaces yet. Rooms and direct messages will appear here.</p>
      )}
    </section>
  );
}

// ---- Contacts ----
export function ContactsPanel() {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [contactQ, setContactQ] = useState('');
  const toast = useToast();
  async function load() {
    setLoading(true);
    try {
      const r = await fetch('/api/google/contacts');
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || 'Could not load contacts');
      setContacts(d.contacts || []);
    } catch (e: any) {
      toast('error', e.message || 'Could not load contacts');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);
  const term = contactQ.trim().toLowerCase();
  const shown = contacts && term ? contacts.filter((c) => `${c.name} ${c.email || ''} ${c.phone || ''}`.toLowerCase().includes(term)) : contacts;
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-end mb-3">
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 disabled:opacity-50">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>
      {contacts === null ? (
        <p className="text-sm text-zinc-400">Loading your contacts…</p>
      ) : contacts.length ? (
        <>
          <div className="relative mb-3">
            <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-400" />
            <input value={contactQ} onChange={(e) => setContactQ(e.target.value)} placeholder="Filter by name, email or phone…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500" />
          </div>
          {shown && shown.length ? (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {shown.map((c, i) => (
                <li key={`${c.email || c.name}-${i}`} className="flex items-center gap-3 py-2.5">
                  <span className="shrink-0 w-8 h-8 rounded-full bg-sky-500/10 text-sky-600 inline-flex items-center justify-center text-xs font-semibold uppercase">{(c.name || '?').charAt(0)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{c.name}</div>
                    <div className="text-[11px] text-zinc-400 truncate flex items-center gap-2">
                      {c.email && <span className="inline-flex items-center gap-1"><Mail size={10} /> {c.email}</span>}
                      {c.phone && <span className="inline-flex items-center gap-1"><Phone size={10} /> {c.phone}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-zinc-400">No contacts match “{contactQ}”.</p>
          )}
          <p className="mt-2 text-[11px] text-zinc-400">{contacts.length} contact{contacts.length === 1 ? '' : 's'}</p>
        </>
      ) : (
        <p className="text-sm text-zinc-400">No contacts found.</p>
      )}
    </section>
  );
}
