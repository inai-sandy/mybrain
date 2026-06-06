function Letter({ on, label, letter }: { on?: boolean; label: string; letter: string }) {
  return (
    <span
      title={on ? `In ${label}` : `Not yet in ${label}`}
      className={
        'inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold ' +
        (on ? 'bg-emerald-500/15 text-emerald-500' : 'bg-zinc-500/10 text-zinc-400')
      }
    >
      {letter}
    </span>
  );
}

/** Compact store indicators: S = SuperMemory, R = RAG, C = Chunked. */
export function StoreBadges({ supermemory, rag, chunked }: { supermemory?: boolean; rag?: boolean; chunked?: boolean }) {
  return (
    <span className="inline-flex gap-1">
      <Letter on={supermemory} label="SuperMemory" letter="S" />
      <Letter on={rag} label="RAG" letter="R" />
      <Letter on={chunked} label="Chunked" letter="C" />
    </span>
  );
}
