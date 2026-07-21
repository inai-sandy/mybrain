import { useEffect, useMemo, useRef, useState } from 'react';
import { X, User, Check } from 'lucide-react';

export type PersonOption = { id: string; name: string; aliases?: string[] };

/** Contacts, loaded once per mount and shared by every picker on the screen. (BEA-1019) */
let cache: PersonOption[] | null = null;
let inflight: Promise<PersonOption[]> | null = null;

export function loadContacts(): Promise<PersonOption[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch('/api/contacts/all')
      .then((r) => (r.ok ? r.json() : { contacts: [] }))
      .then((d) => {
        cache = (d.contacts || []).map((c: any) => ({ id: c.id, name: c.name, aliases: c.aliases || [] }));
        return cache!;
      })
      .catch(() => [])
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Drop the cache so a newly added contact shows up straight away. */
export function refreshContacts() { cache = null; }

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Pick the person a task belongs to. Typing filters your contacts; picking one makes a REAL link,
 * so renaming them later carries the task with them. Free text is still allowed — it just says
 * plainly that it isn't linked to anybody, rather than pretending. (BEA-1019)
 */
export function PersonPicker({
  contactId,
  name,
  onChange,
  placeholder = 'Start typing a name…',
  id,
}: {
  contactId: string | null;
  name: string;
  onChange: (v: { contactId: string | null; name: string }) => void;
  placeholder?: string;
  id?: string;
}) {
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { loadContacts().then(setPeople); }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const matches = useMemo(() => {
    const q = norm(name);
    if (!q) return people.slice(0, 8);
    return people
      .filter((p) => [p.name, ...(p.aliases || [])].some((s) => norm(String(s)).includes(q)))
      .slice(0, 8);
  }, [people, name]);

  // Typed text that isn't one of your contacts — say so, don't silently guess who was meant.
  const unmatched = !contactId && !!name.trim() && !people.some((p) => [p.name, ...(p.aliases || [])].some((s) => norm(String(s)) === norm(name)));

  const pick = (p: PersonOption) => { onChange({ contactId: p.id, name: p.name }); setOpen(false); };

  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        <input
          id={id}
          value={name}
          onChange={(e) => { onChange({ contactId: null, name: e.target.value }); setOpen(true); setHi(0); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { setOpen(true); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter' && matches[hi]) { e.preventDefault(); pick(matches[hi]); }
            else if (e.key === 'Escape') setOpen(false);
          }}
          autoComplete="off"
          placeholder={placeholder}
          aria-expanded={open}
          className={`w-full mt-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border px-3 py-2 pr-8 text-sm outline-none focus:border-emerald-500 ${
            contactId ? 'border-emerald-500/60' : 'border-zinc-300 dark:border-zinc-700'
          }`}
        />
        {contactId ? (
          <Check className="absolute right-2.5 top-1/2 translate-y-[1px] w-4 h-4 text-emerald-500 pointer-events-none" aria-hidden />
        ) : name ? (
          <button
            type="button"
            onClick={() => { onChange({ contactId: null, name: '' }); setOpen(false); }}
            className="absolute right-2 top-1/2 translate-y-[1px] p-0.5 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            aria-label="Clear"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </div>

      {unmatched && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
          Not in your contacts — saved as a note, not linked to anyone.
        </p>
      )}

      {open && matches.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-30 left-0 right-0 mt-1 max-h-56 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1"
        >
          {matches.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(p)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                  i === hi ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'text-zinc-700 dark:text-zinc-200'
                }`}
              >
                <User className="w-3.5 h-3.5 shrink-0 opacity-60" />
                <span className="truncate">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
