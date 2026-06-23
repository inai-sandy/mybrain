import { useState } from 'react';
import { Check, X, Pin, MessageSquarePlus } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { sureWord, valenceClass, type Evidence } from './client';

// What a tapped finding / mood-bar needs to show in the read-in-full popup. (BEA-462)
export type FindingView = {
  id?: string;
  label?: string;
  statement: string;
  valence: string;
  confidence: number; // 0–1 or 0–100, sureWord handles both
  evidenceCount?: number;
  evidence?: Evidence[];
  pinned?: boolean;
};

const SIGNAL_WORD: Record<string, string> = {
  done: 'You did this',
  postponed: 'You kept putting this off',
  skipped: 'You planned it but skipped it',
  told: 'From your story',
  created: 'You captured this',
  feedback: 'Your own words',
};

/**
 * Tap-to-read popup for a finding (from Findings, the Map, the Mood bars, or Review). Shows the FULL
 * message, why the Lab thinks it (evidence), how-sure in plain words, and ✓/✗/pin when an id is given.
 */
export function FindingSheet({
  item,
  onClose,
  onConfirm,
  onRefute,
  onPin,
  onNote,
}: {
  item: FindingView;
  onClose: () => void;
  onConfirm?: (id: string) => void;
  onRefute?: (id: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
  onNote?: (id: string, text: string) => void | Promise<void>;
}) {
  const pct = Math.round(item.confidence <= 1 ? item.confidence * 100 : item.confidence);
  const ev = item.evidence ?? [];
  const canAct = !!item.id;
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  return (
    <Sheet onClose={onClose} size="lg">
      {(close) => {
        const act = (fn?: (id: string) => void) => () => {
          if (item.id && fn) fn(item.id);
          close();
        };
        return (
          <div className="p-5 space-y-4">
            {item.label && <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{item.label}</div>}

            <p className={'text-base font-semibold leading-snug ' + valenceClass(item.valence)}>{item.statement}</p>

            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 font-medium">{sureWord(item.confidence)}</span>
              <span className="tabular-nums">{pct}% sure</span>
              {typeof item.evidenceCount === 'number' && <span>· seen {item.evidenceCount}×</span>}
              <span className={'ml-auto ' + valenceClass(item.valence)}>{item.valence === 'energizing' ? 'lifts you up' : item.valence === 'draining' ? 'wears you down' : 'neutral'}</span>
            </div>

            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">Why I think this</div>
              {ev.length > 0 ? (
                <ul className="space-y-1.5">
                  {ev.map((e) => (
                    <li key={e.id} className="text-sm text-zinc-600 dark:text-zinc-300 flex gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-zinc-400 shrink-0 mt-0.5 w-20">{SIGNAL_WORD[e.signal] || e.signal}</span>
                      <span className="min-w-0">{e.snippet || '—'}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-zinc-500">I noticed this {item.evidenceCount ? `${item.evidenceCount} time${item.evidenceCount === 1 ? '' : 's'}` : 'across'} in your days.</p>
              )}
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed border-t border-zinc-100 dark:border-zinc-800 pt-3">
              This is a guess from your days — not a fact. Tap <b>Yes</b> if it's true (I'll trust it more) or <b>No</b> if it's wrong (I'll drop it and stop saying it).
            </p>

            {canAct && (
              <div className="flex items-center gap-2 pt-1">
                {onConfirm && (
                  <button onClick={act(onConfirm)} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-3 py-2 text-sm font-medium hover:bg-emerald-500/25">
                    <Check size={15} /> Yes, that's me
                  </button>
                )}
                {onRefute && (
                  <button onClick={act(onRefute)} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-rose-500/15 text-rose-600 dark:text-rose-400 px-3 py-2 text-sm font-medium hover:bg-rose-500/25">
                    <X size={15} /> No, that's wrong
                  </button>
                )}
                {onPin && (
                  <button
                    onClick={() => item.id && onPin(item.id, !item.pinned)}
                    title={item.pinned ? 'Unpin' : 'Pin'}
                    className={'grid place-items-center h-9 w-9 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 ' + (item.pinned ? 'text-amber-500' : 'text-zinc-400 hover:text-amber-500')}
                  >
                    <Pin size={15} className={item.pinned ? 'fill-amber-400' : ''} />
                  </button>
                )}
              </div>
            )}

            {canAct && onNote && (
              noteOpen ? (
                <div className="space-y-2">
                  <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Tell me in your own words — what's right, what's off, what I'm missing…" className="w-full text-sm rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 outline-none focus:border-violet-500" />
                  <div className="flex gap-2">
                    <button
                      disabled={noteBusy || !note.trim()}
                      onClick={async () => { if (!item.id || !note.trim()) return; setNoteBusy(true); await onNote(item.id, note.trim()); close(); }}
                      className="rounded-lg bg-violet-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-violet-500 disabled:opacity-50"
                    >
                      Save note
                    </button>
                    <button onClick={() => setNoteOpen(false)} className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-500">Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setNoteOpen(true)} className="inline-flex items-center gap-1.5 text-sm text-violet-600 dark:text-violet-400 hover:underline">
                  <MessageSquarePlus size={15} /> Add a note in your own words
                </button>
              )
            )}

            <button onClick={close} className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">Close</button>
          </div>
        );
      }}
    </Sheet>
  );
}
