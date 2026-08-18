import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

/**
 * The "Facts" fold (BEA-1368) — one action's know-how card, drawn small in house style on the
 * Social endpoint card and on the `/tools` sheet's action rows: fields · paging · cost · health ·
 * notes. Read from `GET /api/tools/knowledge/:actionId` the first time it is opened, never before —
 * a closed fold costs nothing and the list it sits in never waits on it.
 */

export type ToolKnowledge = {
  actionId: string;
  name: string;
  service: string;
  provider: 'social' | 'services';
  params: { name: string; required: boolean; type?: string; enum?: string[]; description?: string }[];
  fields: { path: string; kind: string; example?: any; seen: boolean; description?: string }[];
  hasDateField: boolean;
  responseNote?: string;
  paging: { how: 'cursor' | 'page' | 'none'; field?: string; pageSize?: number; cap?: number; source: string };
  cost: { free?: boolean; credits?: { typical: number; min: number; max: number }; note?: string; source: string };
  health: { ok: boolean; known: boolean; lastOkAt?: string; lastFailAt?: string; successesLast24h: number; failuresLast24h: number; emptyLast24h: number; callsLast30d: number; lastError?: string; note?: string };
  notes: string[];
  updatedAt: string;
};

const KIND_ORDER = ['date', 'number', 'id', 'url', 'text', 'bool', 'list', 'object'];
const KIND_LABEL: Record<string, string> = { date: 'date', number: 'number', id: 'id', url: 'link', text: 'text', bool: 'yes/no', list: 'list', object: 'group' };
/** How many fields to draw before "and N more" — a profile answer has 60+. */
const FIELDS_SHOWN = 24;

/** The one-line summary that sits on the fold's header: health dot + cost + paging, all from the card. */
export function factsSummary(k: ToolKnowledge): string {
  const parts: string[] = [];
  if (k.cost.free) parts.push('free');
  else if (k.cost.credits) parts.push(k.cost.credits.typical === k.cost.credits.max && k.cost.credits.typical === k.cost.credits.min ? `${k.cost.credits.typical} credit${k.cost.credits.typical === 1 ? '' : 's'}` : `~${k.cost.credits.typical} credits (${k.cost.credits.min}–${k.cost.credits.max})`);
  if (k.paging.how !== 'none') parts.push(`pages by ${k.paging.how}${k.paging.pageSize ? ` · ${k.paging.pageSize}/page` : ''}${k.paging.cap ? ` · up to ${k.paging.cap}` : ''}`);
  else parts.push('one page');
  parts.push(k.hasDateField ? 'has dates' : 'no date field');
  return parts.join(' · ');
}

/** The health line in plain words, and which colour it should be. */
export function healthTone(h: ToolKnowledge['health']): 'ok' | 'bad' | 'quiet' {
  if (!h.known && h.ok) return 'quiet';
  return h.ok ? 'ok' : 'bad';
}

function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function ToolFacts({ actionId, className = '' }: { actionId: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<ToolKnowledge | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [allFields, setAllFields] = useState(false);

  useEffect(() => {
    if (!open || card || state === 'loading') return;
    let alive = true;
    setState('loading');
    fetch(`/api/tools/knowledge/${encodeURIComponent(actionId)}`)
      .then(async (r) => { if (!r.ok) throw new Error('failed'); return r.json(); })
      .then((d) => { if (alive) { setCard(d); setState('idle'); } })
      .catch(() => { if (alive) setState('failed'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, actionId]);

  const tone = card ? healthTone(card.health) : 'quiet';
  const dot = tone === 'ok' ? 'bg-emerald-500' : tone === 'bad' ? 'bg-red-500' : 'bg-zinc-400';

  return (
    <div className={'min-w-0 ' + className} data-testid="tool-facts">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-expanded={open}
        className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <BookOpen size={12} className="shrink-0" />
        <span>Facts</span>
        {card && <span className={'h-1.5 w-1.5 shrink-0 rounded-full ' + dot} aria-hidden />}
        {card && <span className="min-w-0 truncate font-normal text-zinc-400">{factsSummary(card)}</span>}
        {open ? <ChevronUp size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
      </button>

      {open && (
        <div className="mt-1 min-w-0 rounded-lg border border-zinc-200 bg-zinc-50/60 p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-950/40 sm:p-3">
          {state === 'loading' && !card && <p className="flex items-center gap-2 text-zinc-500"><Loader2 size={13} className="animate-spin" /> Reading what we know…</p>}
          {state === 'failed' && !card && <p className="flex items-center gap-2 text-amber-700 dark:text-amber-300"><AlertTriangle size={13} /> Could not read the facts right now.</p>}
          {card && (
            <div className="space-y-2.5">
              {/* Health — the line the builder plans around. */}
              <Row label="Health">
                <span className="flex min-w-0 items-start gap-1.5">
                  <span className={'mt-1 h-2 w-2 shrink-0 rounded-full ' + dot} aria-hidden />
                  <span className={'min-w-0 break-words ' + (tone === 'bad' ? 'text-red-700 dark:text-red-300' : tone === 'ok' ? 'text-emerald-700 dark:text-emerald-300' : 'text-zinc-500 dark:text-zinc-400')}>
                    {card.health.note || (card.health.ok ? 'Working.' : 'Failing.')}
                    {card.health.lastOkAt && card.health.known && <span className="text-zinc-400"> Last worked {when(card.health.lastOkAt)}.</span>}
                  </span>
                </span>
              </Row>

              <Row label="Cost">
                <span className="break-words">
                  {card.cost.free ? 'Free — runs on the connected account.' : card.cost.credits ? (card.cost.credits.min === card.cost.credits.max ? `${card.cost.credits.typical} credit${card.cost.credits.typical === 1 ? '' : 's'} per call` : `Usually ${card.cost.credits.typical} credit${card.cost.credits.typical === 1 ? '' : 's'} per call (seen ${card.cost.credits.min}–${card.cost.credits.max})`) : 'Not known yet'}
                  {card.cost.source === 'observed' && <span className="text-zinc-400"> · from real calls</span>}
                  {card.cost.note && !card.cost.free && <span className="block text-zinc-400">{card.cost.note}</span>}
                </span>
              </Row>

              <Row label="Paging">
                <span className="break-words">
                  {card.paging.how === 'none'
                    ? 'One answer, no pages.'
                    : `Pages by ${card.paging.how}${card.paging.field ? ` (${card.paging.field})` : ''}${card.paging.pageSize ? ` · ${card.paging.pageSize} per page` : ''}${card.paging.cap ? ` · at most ${card.paging.cap} pages` : ''}.`}
                </span>
              </Row>

              <Row label="Fields">
                {card.fields.length === 0 ? (
                  <span className="break-words text-zinc-500 dark:text-zinc-400">{card.responseNote || 'The vendor does not list the answer\'s fields; they will show here after the first real call.'}</span>
                ) : (
                  <span className="min-w-0">
                    <span className={'mr-1.5 inline-block rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' + (card.hasDateField ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300')}>
                      {card.hasDateField ? 'has dates' : 'no date field'}
                    </span>
                    {card.fields.length} field{card.fields.length === 1 ? '' : 's'}
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      {[...card.fields]
                        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
                        .slice(0, allFields ? undefined : FIELDS_SHOWN)
                        .map((f) => (
                          <span
                            key={f.path}
                            title={[f.description, f.example !== undefined ? `e.g. ${String(f.example)}` : '', f.seen ? 'seen in a real answer' : 'from the spec'].filter(Boolean).join(' · ')}
                            className={'inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10.5px] ' + (f.kind === 'date' ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : 'border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300') + (f.seen ? '' : ' opacity-70')}
                          >
                            <span className="truncate">{f.path}</span>
                            <span className="shrink-0 font-sans text-[9.5px] uppercase text-zinc-400">{KIND_LABEL[f.kind] || f.kind}</span>
                          </span>
                        ))}
                      {card.fields.length > FIELDS_SHOWN && (
                        <button type="button" onClick={() => setAllFields((v) => !v)} className="rounded px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-600 hover:bg-emerald-500/10">
                          {allFields ? 'fewer' : `and ${card.fields.length - FIELDS_SHOWN} more`}
                        </button>
                      )}
                    </span>
                    {card.responseNote && <span className="mt-1 block text-zinc-400">{card.responseNote}</span>}
                  </span>
                )}
              </Row>

              {card.notes.length > 0 && (
                <Row label="Notes">
                  <ul className="min-w-0 list-disc space-y-1 pl-4">
                    {card.notes.map((n, i) => <li key={i} className="break-words">{n}</li>)}
                  </ul>
                </Row>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[3.75rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 sm:grid-cols-[4.5rem_minmax(0,1fr)]">
      <span className="pt-px text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{label}</span>
      <div className="min-w-0 text-zinc-700 dark:text-zinc-300">{children}</div>
    </div>
  );
}
