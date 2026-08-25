import { useState } from 'react';
import { Loader2, Send, Wrench } from 'lucide-react';

/**
 * "Send to Codex" (BEA-1466) — the moment the owner says "ok".
 *
 * His design, 2026-08-25: *"It will just send the transcription after I say ok… It should just send
 * the transcription to Codex."*
 *
 * So this is deliberately the plainest thing on the screen. It does not preview, score, summarise or
 * describe the conversation — it sends it, whole, with the tools he named. The only thing it shows
 * beyond the button is that list of tools, and it shows them so he can catch the chat picking up the
 * wrong one, which is the single piece of interpretation left anywhere in this path.
 *
 * What it must never become: a "here is what I understood" card. Every version of that this app has
 * had ended with him receiving something he had not asked for.
 */
export function SendToCodex({ tools, turns, busy, onSend }: {
  /** The action ids the chat heard him name. Shown so he can correct them. */
  tools: string[];
  /** How many turns will cross. Not a summary — a count, so an empty chat is obvious. */
  turns: number;
  busy?: boolean;
  onSend: () => void;
}) {
  const [open, setOpen] = useState(false);
  const nothing = turns === 0;

  return (
    <div className="rounded-xl border border-emerald-300 bg-emerald-50/60 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10" data-testid="send-to-codex">
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">When you are happy</p>
      <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-200">
        Your whole conversation goes to Codex, exactly as written. It works out what to build and tells you the goal before anything is made.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="send-tools">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
        {tools.length ? (
          <>
            {tools.map((t) => (
              <span key={t} className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">{t}</span>
            ))}
            <button
              type="button"
              data-testid="send-tools-note"
              onClick={() => setOpen((v) => !v)}
              className="text-[11px] underline underline-offset-2 text-zinc-500 dark:text-zinc-400"
            >
              not right?
            </button>
          </>
        ) : (
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">No tools named yet — say which ones it should use.</span>
        )}
      </div>

      {open && (
        <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          Say so in the chat — “use Gmail fetch emails and WhatsApp send” — and the list changes. Only these go over; nothing else from your catalogue.
        </p>
      )}

      <button
        data-testid="send-codex"
        onClick={onSend}
        disabled={busy || nothing}
        className="mt-3 inline-flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 sm:w-auto"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        Send to Codex
      </button>
      <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        {nothing ? 'Say what you want first.' : 'Nothing is built yet — you read the goal and approve it first.'}
      </p>
    </div>
  );
}
