import { useState } from 'react';
import { Check, Loader2, MessageCircleQuestion, Send, Sparkles } from 'lucide-react';

/**
 * THE GOAL (BEA-1487) — what Codex is going to build, in its own words, for him to approve.
 *
 * His design, 2026-08-25: *"We should ask codex to create a goal and send it for approval. when i
 * approve the goal it has to create an agent and run a sample task to match the goal."*
 *
 * This screen replaces the brief screen, and the difference is the whole point: a brief was seven
 * sections and tagged lines that the APP wrote by reading his conversation, and every structure it
 * invented put a defect in front of him — a row count where he wanted summaries, a "Read it here:"
 * with nothing after it, a sentence with no verb. So there is no structure here at all. Codex's text
 * is rendered as Codex wrote it, and the only things on the screen besides it are the three things
 * he can do: approve it, send it back, or answer a question.
 *
 * **Nothing here parses, scores, highlights or summarises the goal.** If a future version starts
 * pulling headings or bullet counts out of this text to draw a nicer card, the app has begun
 * interpreting again, and that is the bug this whole design exists to remove.
 */

export type Goal = {
  id: string;
  version: number;
  /** proposed | approved | sent_back | asking */
  status: string;
  text: string;
  /** Set only while `asking` — Codex needs him before it can write the goal at all. */
  question?: string | null;
  note?: string | null;
  tools: string[];
  approvedAt?: string | null;
  /** What became of it after approval (BEA-1467) — building | done | failed, and why. */
  run?: { status: string; error?: string | null; resultText?: string | null; agentId?: string | null; runId?: string | null } | null;
};

export function GoalView({ goal, busy, onApprove, onSendBack, onAnswer }: {
  goal: Goal | null;
  busy?: boolean;
  onApprove: () => void;
  onSendBack: (note: string) => void;
  onAnswer: (text: string) => void;
}) {
  const [note, setNote] = useState('');
  const [answer, setAnswer] = useState('');
  const [changing, setChanging] = useState(false);

  if (!goal) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400" data-testid="goal-none">
        Nothing yet. When you are happy with the conversation, send it over and Codex will tell you what it is going to build.
      </p>
    );
  }

  // Codex needs him before it can write a goal. There is deliberately nothing to approve on this
  // screen while that is true — approving a question mark is how a guess becomes a requirement.
  if (goal.status === 'asking') {
    return (
      <div className="flex flex-col gap-3" data-testid="goal-asking">
        <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50/70 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
          <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">Codex needs to know</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{goal.question}</p>
          </div>
        </div>
        <textarea
          data-testid="goal-answer"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={3}
          placeholder="Answer it in your own words…"
          className="w-full rounded-lg border border-zinc-200 bg-white p-2.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          data-testid="goal-answer-send"
          onClick={() => { onAnswer(answer); setAnswer(''); }}
          disabled={busy || !answer.trim()}
          className="inline-flex min-h-[40px] items-center justify-center gap-1.5 self-start rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Answer
        </button>
      </div>
    );
  }

  const approved = goal.status === 'approved';

  return (
    <div className="flex flex-col gap-3" data-testid="goal-view">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          The goal, in Codex’s words
        </span>
        <span className="text-[11px] text-zinc-400">v{goal.version}</span>
        {approved && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" data-testid="goal-approved">
            <Check className="h-3 w-3" aria-hidden />
            Approved
          </span>
        )}
      </div>

      {/* Codex's text, exactly as written. `whitespace-pre-wrap` and nothing else — no parsing. */}
      <div
        data-testid="goal-text"
        className="whitespace-pre-wrap break-words rounded-xl border border-zinc-200 bg-zinc-50 p-3.5 text-sm leading-relaxed dark:border-zinc-700 dark:bg-zinc-800/60"
      >
        {goal.text}
      </div>

      {!!goal.tools.length && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400" data-testid="goal-tools">
          Built with the tools you named: {goal.tools.join(', ')}
        </p>
      )}

      {approved ? (
        <GoalOutcome run={goal.run} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              data-testid="goal-approve"
              onClick={onApprove}
              disabled={busy || !goal.text.trim()}
              className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              This is right — build it
            </button>
            <button
              data-testid="goal-change"
              onClick={() => setChanging((v) => !v)}
              disabled={busy}
              className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
            >
              Something is wrong
            </button>
          </div>

          {changing && (
            <div className="flex flex-col gap-2">
              <textarea
                data-testid="goal-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Say what it got wrong. Codex reads this sentence and writes the goal again."
                className="w-full rounded-lg border border-zinc-200 bg-white p-2.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                data-testid="goal-send-back"
                onClick={() => { onSendBack(note); setNote(''); setChanging(false); }}
                disabled={busy || !note.trim()}
                className="inline-flex min-h-[40px] items-center justify-center gap-1.5 self-start rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send it back
              </button>
            </div>
          )}

          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Nothing is built until you approve this.</p>
        </>
      )}
    </div>
  );
}

/**
 * What became of the goal after he approved it (BEA-1467).
 *
 * This screen used to show ONE static sentence — "Codex is building it" — for ever. He sat in front
 * of it for an hour while, unseen, Codex had built the program, run it, and failed with a perfectly
 * clear reason. The sentence was true for about two minutes and a lie for the other fifty-eight.
 *
 * So it reads the run. A failure shows the program's OWN words, because they are almost always
 * actionable — the real one was "I could not find a Gmail email search/fetch action… name the right
 * action, then run this again", which tells him exactly what to do.
 */
export function GoalOutcome({ run }: { run?: Goal['run'] }) {
  if (!run || run.status === 'building' || run.status === 'running') {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400" data-testid="goal-run-building">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Codex is building it, then running it once. Nothing is saved or sent. This takes a few minutes.
      </p>
    );
  }

  if (run.status === 'failed') {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50/70 p-2.5 dark:border-red-500/30 dark:bg-red-500/10" data-testid="goal-run-failed">
        <p className="text-xs font-semibold text-red-800 dark:text-red-300">It ran and could not finish</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">
          {run.error || 'It stopped without saying why.'}
        </p>
        <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">Nothing was saved or sent. Fix what it asks for and send the conversation again.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-emerald-300 bg-emerald-50/70 p-2.5 dark:border-emerald-500/30 dark:bg-emerald-500/10" data-testid="goal-run-done">
      <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">It ran once — nothing saved, nothing sent</p>
      {run.resultText && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">{run.resultText}</p>}
      <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">Check it against the goal above. There is a message on your phone to keep it or send it back.</p>
    </div>
  );
}
