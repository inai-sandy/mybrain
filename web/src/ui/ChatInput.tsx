import { Loader2, Send } from 'lucide-react';
import { GrowTextarea } from './GrowTextarea';
import { DictateButton } from './DictateButton';

/**
 * The one chat input (BEA-1251). Multi-line, grows with what you type, and Enter behaves the way
 * the device expects:
 *  - keyboard (laptop): Enter sends, Shift+Enter makes a new line — the convention everywhere.
 *  - touch (phone): Enter makes a new line and the send button sends. Phones have no Shift key,
 *    and "Enter fired my message mid-thought" was exactly the owner's complaint.
 *
 * Before this, every agent chat was a single-line <input> with Enter hard-wired to send — a new
 * line was not hidden, it was impossible.
 */
const touchDevice = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

export function ChatInput({ value, onChange, onSend, busy, placeholder, autoFocus, accent = 'emerald' }: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  accent?: 'emerald' | 'violet';
}) {
  const ring = accent === 'violet' ? 'focus:border-violet-400' : 'focus:border-emerald-400';
  const btn = accent === 'violet' ? 'bg-violet-600 hover:bg-violet-500' : 'bg-emerald-600 hover:bg-emerald-500';
  return (
    <div className="flex items-end gap-2">
      <div className="relative min-w-0 flex-1">
        <GrowTextarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !touchDevice()) {
              e.preventDefault(); // never also insert the newline the key would type
              onSend();
            }
          }}
          autoFocus={autoFocus}
          placeholder={placeholder}
          minHeight={44}
          maxHeight={160}
          className={'w-full rounded-xl border border-zinc-200 bg-transparent px-3 py-2.5 pr-11 text-base outline-none dark:border-zinc-700 sm:text-sm ' + ring}
        />
        <DictateButton onText={(t) => onChange((value ? value + ' ' : '') + t)} className="absolute bottom-2.5 right-2" />
      </div>
      <button onClick={onSend} disabled={busy || !value.trim()} aria-label="Send" title="Send" className={'shrink-0 rounded-xl p-2.5 text-white disabled:opacity-50 ' + btn}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      </button>
    </div>
  );
}
