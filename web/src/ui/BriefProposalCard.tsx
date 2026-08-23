import { ArrowRight, Loader2, Search, Send, Sparkles } from 'lucide-react';

/**
 * The short card in the chat when the builder has written a brief (BEA-1424).
 *
 * Deliberately NOT the brief. The brief has its own screen, and putting the whole thing in a chat
 * bubble is how it becomes a wall of text he scrolls past — the exact failure BEA-1416 exists to
 * prevent. What belongs here is only enough to decide whether to open it: what it is called, what it
 * fetches, whether it will message him, and **how many lines are the AI's own guesses**, because
 * that is the number that tells him how much checking there is to do.
 *
 * One button. Nothing is built by pressing it — it gives the brief a home and opens it.
 */
export function BriefProposalCard({ card, opening, onOpen }: {
  card: { name: string; guesses: number; lines: number; sources: string[]; sends: boolean };
  opening?: boolean;
  onOpen: () => void;
}) {
  return (
    <div data-testid="builder-brief" className="rounded-xl border border-violet-300 bg-violet-50/60 p-3 dark:border-violet-500/30 dark:bg-violet-500/10">
      <p className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">The brief</p>
      <div className="mt-1 break-words text-sm font-semibold">{card.name}</div>

      <div className="mt-2 space-y-1.5 text-xs text-zinc-700 dark:text-zinc-200">
        <div className="flex gap-2">
          <Search className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden />
          <span className="min-w-0 break-words">
            <span className="font-semibold text-zinc-500 dark:text-zinc-400">Fetches </span>
            {card.sources.length ? card.sources.join(', ') : 'nothing yet'}
          </span>
        </div>
        {card.sends && (
          <div className="flex gap-2">
            <Send className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden />
            <span className="min-w-0 break-words">
              <span className="font-semibold text-zinc-500 dark:text-zinc-400">Tells you </span>
              on WhatsApp — the exact message is in the brief
            </span>
          </div>
        )}
        <div className="flex gap-2">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
          <span className="min-w-0 break-words" data-testid="brief-guess-count">
            <span className="font-semibold text-zinc-500 dark:text-zinc-400">To check </span>
            {card.guesses === 0
              ? 'nothing — it is all your words'
              : `${card.guesses} of the ${card.lines} lines ${card.guesses === 1 ? 'is' : 'are'} my guess, not yours`}
          </span>
        </div>
      </div>

      <button
        data-testid="brief-open"
        onClick={onOpen}
        disabled={opening}
        className="mt-3 inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 sm:w-auto"
      >
        {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
        Read it and run it once
      </button>
      <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">Nothing is built yet. You read it, watch it run once for real, and only then keep it.</p>
    </div>
  );
}
