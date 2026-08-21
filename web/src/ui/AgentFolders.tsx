import { useRef, useState } from 'react';
import { Check, FolderPlus, Loader2, Pencil, Trash2, X } from 'lucide-react';

/**
 * Flat folders on the Agents home (BEA-1380). The owner creates them and moves his agent cards in;
 * "All" and "Unfiled" are always there. One drawing, two shapes: a chips row on the phone (390) and
 * a left rail on the laptop (1180) — same data, same handlers.
 */
export type AgentFolder = { id: string; name: string; order: number; count?: number };

/** null = All · 'unfiled' = Unfiled · anything else = a folder id. */
export type FolderSel = string | null;

export type FolderCounts = { all: number; unfiled: number; byFolder: Record<string, number> };

/** Count the cards under each folder from the areas list itself — always in step with what's drawn. */
export function folderCounts(areas: { folderId?: string | null }[]): FolderCounts {
  const byFolder: Record<string, number> = {};
  let unfiled = 0;
  for (const a of areas) {
    if (a.folderId) byFolder[a.folderId] = (byFolder[a.folderId] || 0) + 1;
    else unfiled += 1;
  }
  return { all: areas.length, unfiled, byFolder };
}

/** The cards the selected folder shows: All → everything, 'unfiled' → no folder, id → that folder. */
export function inFolder<T extends { folderId?: string | null }>(areas: T[], sel: FolderSel): T[] {
  if (sel === null) return areas;
  if (sel === 'unfiled') return areas.filter((a) => !a.folderId);
  return areas.filter((a) => a.folderId === sel);
}

type NavProps = {
  variant: 'rail' | 'chips';
  folders: AgentFolder[];
  counts: FolderCounts;
  active: FolderSel;
  onSelect: (sel: FolderSel) => void;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => void;
};

/** The New-folder inline input — shared by both shapes and the move picker. */
function NewFolderInline({ onCreate, onDone, compact }: { onCreate: (name: string) => Promise<boolean>; onDone: () => void; compact?: boolean }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!name.trim() || busy) return;
    setBusy(true);
    const ok = await onCreate(name.trim());
    setBusy(false);
    if (ok) { setName(''); onDone(); }
  }
  return (
    <div className={'flex items-center gap-1.5 ' + (compact ? '' : 'px-1')}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') onDone(); }}
        autoFocus
        placeholder="Folder name…"
        aria-label="New folder name"
        className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-base outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900 sm:text-xs"
      />
      <button onClick={go} disabled={busy || !name.trim()} aria-label="Create folder" className="shrink-0 rounded-lg bg-emerald-600 p-1.5 text-white hover:bg-emerald-500 disabled:opacity-50">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
      </button>
      <button onClick={onDone} aria-label="Cancel new folder" className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

/**
 * Rename & delete for one folder — INLINE icon buttons, never an absolute dropdown: the chips row
 * scrolls sideways (overflow-x-auto), and an absolute menu inside a scroll container gets clipped.
 */
function FolderActions({ f, onRename, onDelete }: { f: AgentFolder; onRename: (id: string, name: string) => Promise<boolean>; onDelete: (id: string) => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(f.name);
  if (renaming) {
    return (
      <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label={`Rename folder ${f.name}`}
          onKeyDown={async (e) => { if (e.key === 'Enter' && name.trim()) { if (await onRename(f.id, name.trim())) setRenaming(false); } if (e.key === 'Escape') { setName(f.name); setRenaming(false); } }}
          className="w-24 rounded border border-emerald-400 bg-white px-1.5 py-0.5 text-xs outline-none dark:bg-zinc-900" />
        <button onClick={async () => { if (name.trim() && (await onRename(f.id, name.trim()))) setRenaming(false); }} aria-label="Save folder name" className="p-0.5 text-emerald-600"><Check className="h-3.5 w-3.5" /></button>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
      <button onClick={() => { setName(f.name); setRenaming(true); }} aria-label={`Rename folder ${f.name}`} className="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><Pencil className="h-3 w-3" /></button>
      <button onClick={() => onDelete(f.id)} aria-label={`Delete folder ${f.name}`} className="rounded p-1 text-zinc-400 hover:text-rose-600"><Trash2 className="h-3 w-3" /></button>
    </span>
  );
}

/**
 * The folder nav. `rail` = the laptop left rail (render inside `hidden lg:block`);
 * `chips` = the phone row (render inside `lg:hidden`), horizontally scrollable so 390 never overflows.
 */
export function FolderNav({ variant, folders, counts, active, onSelect, onCreate, onRename, onDelete }: NavProps) {
  const [adding, setAdding] = useState(false);

  const items: { sel: FolderSel; label: string; count: number; folder?: AgentFolder }[] = [
    { sel: null, label: 'All', count: counts.all },
    ...folders.map((f) => ({ sel: f.id as FolderSel, label: f.name, count: counts.byFolder[f.id] || 0, folder: f })),
    { sel: 'unfiled' as FolderSel, label: 'Unfiled', count: counts.unfiled },
  ];

  if (variant === 'rail') {
    return (
      <nav aria-label="Agent folders" data-testid="folder-rail" className="space-y-0.5">
        {items.map((it) => {
          const on = active === it.sel;
          return (
            <div key={String(it.sel)} className={'group/frow flex items-center rounded-lg ' + (on ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60')}>
              <button onClick={() => onSelect(it.sel)} aria-current={on ? 'true' : undefined}
                className={'flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-sm ' + (on ? 'font-semibold text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-300')}>
                <span aria-hidden className="shrink-0 text-xs">{it.sel === null ? '🗂' : it.sel === 'unfiled' ? '📄' : '📁'}</span>
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                <span className={'shrink-0 rounded-full px-1.5 text-[11px] ' + (on ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200' : 'text-zinc-400')}>{it.count}</span>
              </button>
              {it.folder && <span className={'pr-1 focus-within:opacity-100 ' + (on ? 'opacity-100' : 'opacity-0 group-hover/frow:opacity-100')}><FolderActions f={it.folder} onRename={onRename} onDelete={onDelete} /></span>}
            </div>
          );
        })}
        <div className="pt-1">
          {adding ? (
            <NewFolderInline onCreate={onCreate} onDone={() => setAdding(false)} />
          ) : (
            <button onClick={() => setAdding(true)} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200">
              <FolderPlus className="h-4 w-4" />New folder
            </button>
          )}
        </div>
      </nav>
    );
  }

  // chips (phone): one scrollable row — the page itself must never scroll sideways.
  return (
    <div data-testid="folder-chips" className="space-y-1.5">
      <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5" role="tablist" aria-label="Agent folders">
        {items.map((it) => {
          const on = active === it.sel;
          return (
            <span key={String(it.sel)} className="flex shrink-0 items-center">
              <button onClick={() => onSelect(it.sel)} role="tab" aria-selected={on}
                className={'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ' +
                  (on ? 'border-emerald-500 bg-emerald-600 text-white' : 'border-zinc-200 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300')}>
                {it.label}
                <span className={'rounded-full px-1 text-[10px] ' + (on ? 'bg-white/20' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400')}>{it.count}</span>
              </button>
              {it.folder && on && <FolderActions f={it.folder} onRename={onRename} onDelete={onDelete} />}
            </span>
          );
        })}
        {adding ? null : (
          <button onClick={() => setAdding(true)} aria-label="New folder" className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
            <FolderPlus className="h-3.5 w-3.5" />New
          </button>
        )}
      </div>
      {adding && <NewFolderInline compact onCreate={onCreate} onDone={() => setAdding(false)} />}
    </div>
  );
}

/**
 * "Move to folder…" picker — one drawing for the card menu and the multi-select bar.
 * Lists Unfiled + every folder + "+ New folder"; picking calls back and closes.
 */
export function FolderPickerSheet({ folders, title, onPick, onCreate, onClose }: {
  folders: AgentFolder[];
  title: string;
  onPick: (folderId: string | null) => void;
  onCreate: (name: string) => Promise<AgentFolder | null>;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const busyRef = useRef(false);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div data-testid="folder-picker" className="w-full max-w-sm space-y-2 rounded-t-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          <button onClick={() => onPick(null)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <span aria-hidden>📄</span>Unfiled <span className="ml-auto text-[11px] text-zinc-400">no folder</span>
          </button>
          {folders.map((f) => (
            <button key={f.id} onClick={() => onPick(f.id)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <span aria-hidden>📁</span><span className="min-w-0 flex-1 truncate">{f.name}</span>
              {typeof f.count === 'number' && <span className="text-[11px] text-zinc-400">{f.count}</span>}
            </button>
          ))}
          {folders.length === 0 && <p className="px-3 py-1 text-xs text-zinc-400">No folders yet — make the first one below.</p>}
        </div>
        {adding ? (
          <NewFolderInline compact onDone={() => setAdding(false)} onCreate={async (name) => {
            if (busyRef.current) return false;
            busyRef.current = true;
            const made = await onCreate(name);
            busyRef.current = false;
            if (made) onPick(made.id); // straight into the brand-new folder
            return !!made;
          }} />
        ) : (
          <button onClick={() => setAdding(true)} className="flex w-full items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-left text-sm text-zinc-500 hover:border-emerald-400 hover:text-emerald-700 dark:border-zinc-600 dark:hover:text-emerald-300">
            <FolderPlus className="h-4 w-4" />New folder
          </button>
        )}
      </div>
    </div>
  );
}
