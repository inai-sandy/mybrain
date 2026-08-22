import { useState } from 'react';
import { Check, ChevronRight, Eye, Loader2, Pencil, Plus, RotateCcw, Sparkles, User, X } from 'lucide-react';

/**
 * The brief, on one screen (BEA-1406, "Brief First").
 *
 * The owner has never been able to see what the builder actually filled in — only what it typed in
 * the chat. On the night this was designed, the AI's invention and his own instruction were printed
 * in the same colour, in the same paragraph, and there was no way to tell them apart. He approved
 * the invention and lost nine hours.
 *
 * So the one job of this screen: **every line says where it came from, and the AI's guesses are the
 * ones your eye lands on.** Everything else here is in service of that.
 */

export type LineOrigin = 'owner' | 'tool' | 'ai';
export type BriefLine = { id: string; text: string; origin: LineOrigin; struck?: boolean; evidence?: { callId: string; sampleId?: string; actionId?: string } };
export type SectionKey = 'want' | 'sources' | 'filter' | 'output' | 'when' | 'success' | 'trouble';
export type BriefRefusal = { section: string; why: string };
export type Brief = {
  id: string;
  areaId: string;
  version: number;
  status: 'draft' | 'approved';
  name: string;
  sections: Record<SectionKey, BriefLine[]> & { killed: BriefLine[] };
  sources: { id: string; actionId: string; args: Record<string, any>; evidence?: { callId: string }; saw?: string }[];
  delivery: { whatsapp: boolean; telegram: boolean; messageText: string };
  transcript: { id: string; who: string; text: string; at: string; struck?: boolean }[];
};

export const SECTION_ORDER: SectionKey[] = ['want', 'sources', 'filter', 'output', 'when', 'success', 'trouble'];

export const SECTION_LABELS: Record<SectionKey, string> = {
  want: 'What I want',
  sources: 'Where it comes from',
  filter: 'What counts, what to ignore',
  output: 'What to do with it',
  when: 'When it runs',
  success: 'What "it worked" means',
  trouble: 'If something goes wrong',
};

/** The empty line under a heading — plain words, never "No data". */
const SECTION_EMPTY: Record<SectionKey, string> = {
  want: 'Nothing here yet. Say what you want, in your own words.',
  sources: 'Nothing is set up to fetch anything yet.',
  filter: 'Everything is kept.',
  output: 'Nothing is saved or sent yet.',
  when: 'Only when you press Run.',
  success: 'Nothing yet — so nothing can tell a bad run from a good one.',
  trouble: 'Nothing yet. It will just stop and say so.',
};

// ---- the tag ------------------------------------------------------------------------------------

/**
 * Three tags, three different weights. `my guess` is deliberately the loudest: it is the one he has
 * to check. `your words` is quiet — it is already his. Colour is never the only signal; each tag
 * carries its own icon and its own word, so it still reads in dark mode, on a phone, and for anyone
 * who cannot separate the two colours.
 */
export function OriginTag({ origin }: { origin: LineOrigin }) {
  if (origin === 'owner') {
    return (
      <span data-testid="tag-owner" className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:text-emerald-300 dark:ring-emerald-400/25">
        <User className="h-3 w-3" aria-hidden />your words
      </span>
    );
  }
  if (origin === 'tool') {
    return (
      <span data-testid="tag-tool" className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700 ring-1 ring-inset ring-sky-600/20 dark:text-sky-300 dark:ring-sky-400/25">
        <Eye className="h-3 w-3" aria-hidden />looked
      </span>
    );
  }
  return (
    <span data-testid="tag-ai" className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900 ring-1 ring-inset ring-amber-500/40 dark:bg-amber-400/15 dark:text-amber-200 dark:ring-amber-400/40">
      <Sparkles className="h-3 w-3" aria-hidden />my guess
    </span>
  );
}

// ---- one line ------------------------------------------------------------------------------------

function Line({ line, onEdit, onStrike, onProof, busy }: {
  line: BriefLine;
  onEdit: (id: string, text: string) => void;
  onStrike: (id: string, struck: boolean) => void;
  onProof?: (callId: string) => void;
  busy?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(line.text);

  if (editing) {
    return (
      <li className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/60" data-testid="brief-line-editing">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 48)))}
          aria-label="Edit this line"
          /* 16px on a phone or iOS zooms the whole page in on focus. */
          className="w-full resize-y rounded-md border border-zinc-300 bg-white p-2 text-base leading-snug outline-none focus:border-violet-500 sm:text-sm dark:border-zinc-600 dark:bg-zinc-900"
        />
        <div className="mt-1.5 flex gap-2">
          <button
            data-testid="line-save"
            onClick={() => { setEditing(false); if (draft.trim() && draft !== line.text) onEdit(line.id, draft.trim()); }}
            className="inline-flex min-h-[32px] items-center gap-1 rounded-md bg-violet-600 px-2.5 text-xs font-medium text-white hover:bg-violet-700"
          >
            <Check className="h-3.5 w-3.5" />Save
          </button>
          <button onClick={() => { setEditing(false); setDraft(line.text); }} className="min-h-[32px] rounded-md px-2.5 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Cancel</button>
        </div>
        <p className="mt-1 text-[11px] text-zinc-400">Once you change it, it becomes your words.</p>
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800/40" data-testid="brief-line">
      <div className="min-w-0 flex-1">
        {/*
          The tag runs INLINE with the first line of text rather than in a column beside it. On a
          phone a column of its own left the sentence about 160px wide — seven lines of text with
          half the screen empty. Inline, the text uses the whole width and the tag still reads first.
        */}
        <p className="text-sm leading-snug">
          <OriginTag origin={line.origin} />{' '}
          <span className={`whitespace-pre-wrap break-words align-middle ${line.struck ? 'text-zinc-400 line-through dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-100'}`}>{line.text}</span>
        </p>
        {line.evidence?.callId && onProof && (
          <button
            data-testid="line-proof"
            onClick={() => onProof(line.evidence!.callId)}
            className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-sky-700 hover:underline dark:text-sky-300"
          >
            see what came back<ChevronRight className="h-3 w-3" />
          </button>
        )}
      </div>
      {/* Always visible on a phone — a hover-only control does not exist on a touch screen. */}
      <div className="flex shrink-0 items-center gap-0.5">
        {!line.struck && (
          <button data-testid="line-edit" onClick={() => { setDraft(line.text); setEditing(true); }} disabled={busy} aria-label="Change this line"
            className="grid h-8 w-8 place-items-center rounded-md text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-zinc-700 dark:hover:text-zinc-200">
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          data-testid={line.struck ? 'line-unstrike' : 'line-strike'}
          onClick={() => onStrike(line.id, !line.struck)}
          disabled={busy}
          aria-label={line.struck ? 'Bring this line back' : 'Cross this line out'}
          className="grid h-8 w-8 place-items-center rounded-md text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
        >
          {line.struck ? <RotateCcw className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        </button>
      </div>
    </li>
  );
}

// ---- one section ---------------------------------------------------------------------------------

function Section({ k, lines, refusals, onEdit, onStrike, onAdd, onProof, busy, children }: {
  k: SectionKey;
  lines: BriefLine[];
  refusals: BriefRefusal[];
  onEdit: (id: string, text: string) => void;
  onStrike: (id: string, struck: boolean) => void;
  onAdd: (k: SectionKey, text: string) => void;
  onProof?: (callId: string) => void;
  busy?: boolean;
  children?: any;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const mine = refusals.filter((r) => r.section === k || (k === 'sources' && r.section === 'sources') || (k === 'output' && r.section === 'output'));
  const shown = lines || [];

  return (
    <section data-testid={`brief-section-${k}`} className="border-t border-zinc-200 pt-4 first:border-t-0 first:pt-0 dark:border-zinc-800">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{SECTION_LABELS[k]}</h2>

      {/* The reason sits BESIDE the thing that is missing — not in a toast that disappears. */}
      {mine.map((r, i) => (
        <p key={i} data-testid={`refusal-${k}`} className="mt-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-400/30">
          {r.why}
        </p>
      ))}

      {shown.length === 0 && !children ? (
        <p className="mt-1.5 text-sm text-zinc-400 dark:text-zinc-500">{SECTION_EMPTY[k]}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {shown.map((l) => <Line key={l.id} line={l} onEdit={onEdit} onStrike={onStrike} onProof={onProof} busy={busy} />)}
        </ul>
      )}

      {children}

      {adding ? (
        <div className="mt-1.5">
          <textarea
            autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={2}
            placeholder="In your own words…"
            aria-label={`Add to ${SECTION_LABELS[k]}`}
            className="w-full resize-y rounded-md border border-zinc-300 bg-white p-2 text-base leading-snug outline-none focus:border-violet-500 sm:text-sm dark:border-zinc-600 dark:bg-zinc-900"
          />
          <div className="mt-1.5 flex gap-2">
            <button data-testid={`add-save-${k}`} onClick={() => { const t = text.trim(); setAdding(false); setText(''); if (t) onAdd(k, t); }}
              className="inline-flex min-h-[32px] items-center gap-1 rounded-md bg-violet-600 px-2.5 text-xs font-medium text-white hover:bg-violet-700">
              <Check className="h-3.5 w-3.5" />Add
            </button>
            <button onClick={() => { setAdding(false); setText(''); }} className="min-h-[32px] rounded-md px-2.5 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Cancel</button>
          </div>
        </div>
      ) : (
        <button data-testid={`add-line-${k}`} onClick={() => setAdding(true)} disabled={busy}
          className="mt-1.5 inline-flex min-h-[32px] items-center gap-1 rounded-md px-1 text-xs text-zinc-500 hover:text-violet-700 disabled:opacity-40 dark:hover:text-violet-300">
          <Plus className="h-3.5 w-3.5" />Add a line
        </button>
      )}
    </section>
  );
}

// ---- the message -----------------------------------------------------------------------------------

/**
 * The exact words that will arrive on his phone, drawn as a message rather than as a field. The old
 * form had a checkbox here and nowhere to put the words, which is how he came to be shown a
 * categorised summary in a chat and sent "finished · 5 rows saved to Documents" every night.
 */
export function MessagePreview({ delivery, onEdit, busy }: { delivery: Brief['delivery']; onEdit?: (text: string) => void; busy?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(delivery.messageText || '');
  const to = [delivery.whatsapp ? 'WhatsApp' : '', delivery.telegram ? 'Telegram' : ''].filter(Boolean).join(' and ');
  if (!delivery.whatsapp && !delivery.telegram) return null;

  return (
    <div className="mt-2" data-testid="brief-message">
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">It sends you this on {to}:</p>
      {editing ? (
        <div className="mt-1">
          <textarea
            autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={6}
            aria-label="The message it sends you"
            className="w-full resize-y rounded-md border border-zinc-300 bg-white p-2 font-mono text-base leading-snug outline-none focus:border-violet-500 sm:text-sm dark:border-zinc-600 dark:bg-zinc-900"
          />
          <div className="mt-1.5 flex gap-2">
            <button data-testid="message-save" onClick={() => { setEditing(false); onEdit?.(draft); }}
              className="inline-flex min-h-[32px] items-center gap-1 rounded-md bg-violet-600 px-2.5 text-xs font-medium text-white hover:bg-violet-700">
              <Check className="h-3.5 w-3.5" />Save
            </button>
            <button onClick={() => { setEditing(false); setDraft(delivery.messageText || ''); }} className="min-h-[32px] rounded-md px-2.5 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex items-start gap-2">
          <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm bg-emerald-50 px-3 py-2 ring-1 ring-inset ring-emerald-600/15 dark:bg-emerald-400/10 dark:ring-emerald-400/25">
            {delivery.messageText?.trim() ? (
              <p data-testid="message-text" className="whitespace-pre-wrap break-words text-sm leading-snug text-zinc-800 dark:text-zinc-100">{delivery.messageText}</p>
            ) : (
              <p data-testid="message-empty" className="text-sm italic text-zinc-500 dark:text-zinc-400">Nothing written yet — so nothing useful can arrive.</p>
            )}
          </div>
          {onEdit && (
            <button data-testid="message-edit" onClick={() => { setDraft(delivery.messageText || ''); setEditing(true); }} disabled={busy} aria-label="Change the message"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-zinc-700 dark:hover:text-zinc-200">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---- the whole thing ---------------------------------------------------------------------------------

export function BriefView({ brief, refusals, busy, approving, onEdit, onStrike, onAdd, onMessage, onApprove, onProof }: {
  brief: Brief;
  refusals: BriefRefusal[];
  busy?: boolean;
  approving?: boolean;
  onEdit: (id: string, text: string) => void;
  onStrike: (id: string, struck: boolean) => void;
  onAdd: (k: SectionKey, text: string) => void;
  onMessage: (text: string) => void;
  onApprove: () => void;
  onProof?: (callId: string) => void;
}) {
  const killed = brief.sections.killed || [];
  const approved = brief.status === 'approved';

  return (
    <div className="space-y-4">
      {SECTION_ORDER.map((k) => (
        <Section
          key={k}
          k={k}
          lines={brief.sections[k] || []}
          refusals={refusals}
          onEdit={onEdit}
          onStrike={onStrike}
          onAdd={onAdd}
          onProof={onProof}
          busy={busy}
        >
          {k === 'output' ? <MessagePreview delivery={brief.delivery} onEdit={onMessage} busy={busy} /> : null}
        </Section>
      ))}

      {killed.length > 0 && (
        <section data-testid="brief-killed" className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Killed</h2>
          <p className="mt-1 text-[11px] text-zinc-400">Kept so nothing quietly builds them again.</p>
          <ul className="mt-1 space-y-0.5">
            {killed.map((l) => <Line key={l.id} line={{ ...l, struck: true }} onEdit={onEdit} onStrike={onStrike} onProof={onProof} busy={busy} />)}
          </ul>
        </section>
      )}

      {/* `pr-16` on a phone keeps the button clear of the floating chat bubble, which sits bottom-right. */}
      <div className="sticky bottom-0 -mx-4 border-t border-zinc-200 bg-white/95 py-3 pl-4 pr-16 backdrop-blur sm:pr-4 dark:border-zinc-800 dark:bg-zinc-900/95">
        {approved ? (
          /* Once approved, the trial card above says what happens next in more detail — repeating it
             here in a sticky bar just eats a third of a phone screen. */
          <p data-testid="brief-approved" className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
            <Check className="h-4 w-4" />You approved this.
          </p>
        ) : (
          <>
            <button
              data-testid="brief-approve"
              onClick={onApprove}
              disabled={busy || approving}
              className="inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 sm:w-auto"
            >
              {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              This is right — build it
            </button>
            <p className="mt-1.5 text-[11px] text-zinc-400">
              {refusals.length
                ? `${refusals.length} thing${refusals.length === 1 ? '' : 's'} still to sort out — they are marked above.`
                : 'Nothing is built yet. You will still see it run once before anything is saved or sent.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
