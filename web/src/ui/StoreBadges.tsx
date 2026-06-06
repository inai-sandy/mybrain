import { Check } from 'lucide-react';

function Badge({ on, label }: { on?: boolean; label: string }) {
  return (
    <span
      className={
        'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ' +
        (on ? 'bg-emerald-500/15 text-emerald-500' : 'bg-zinc-500/15 text-zinc-400')
      }
      title={on ? `In ${label}` : `Not yet in ${label}`}
    >
      {on && <Check size={10} />}
      {label}
    </span>
  );
}

/** Where a document is stored: SuperMemory / RAG, and whether it's chunked. */
export function StoreBadges({ supermemory, rag, chunked }: { supermemory?: boolean; rag?: boolean; chunked?: boolean }) {
  return (
    <span className="inline-flex flex-wrap gap-1 justify-end">
      <Badge on={supermemory} label="SuperMemory" />
      <Badge on={rag} label="RAG" />
      {chunked && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400" title="Chunked for retrieval">
          chunked
        </span>
      )}
    </span>
  );
}
