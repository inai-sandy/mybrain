import { useEffect, useState } from 'react';
import { Moon, X, BookOpen, Plus, Trash2, MessageSquare, Clock, Check, Sparkles, Loader2, ArrowRight } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { isDictating } from '../ui/useDictation';
import { DictateButton } from '../ui/DictateButton';
import { GrowTextarea } from '../ui/GrowTextarea';
import { Sheet } from '../ui/Sheet';
import { loadDraft, clearDraft, useDraftPersist } from '../ui/useDraft';

type Story = { id: string; text: string; mood?: string | null; createdAt: string; updatedAt?: string };
type Note = { id: string; text: string; source: string; createdAt: string };
type DailyToday = { day: string; storyDone: boolean; story: Story | null; notes: Note[] };

const MOODS = ['😣 Rough', '😐 Okay', '🙂 Good', '🤩 Great'];

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The story-telling window. Pass `day` + `title` to narrate a past day (from Activity); without them it saves for today. */
type Candidate = { title: string; category: string | null };

export function StoryModal({ initial, day, title, onClose, onSaved }: { initial: { text?: string; mood?: string | null } | null; day?: string; title?: string; onClose: () => void; onSaved: () => void }) {
  const draftKey = `mybrain.draft.story.${day || 'today'}`;
  const [text, setText] = useState(initial?.text || loadDraft(draftKey));
  const [mood, setMood] = useState(initial?.mood || '');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'story' | 'wrap'>('story');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [openTasks, setOpenTasks] = useState<{ id: string; title: string }[]>([]);
  const [carry, setCarry] = useState<Record<string, 'roll' | 'drop' | undefined>>({});
  const [hours, setHours] = useState('');
  const [wrapBusy, setWrapBusy] = useState(false);
  const toast = useToast();
  useDraftPersist(draftKey, step === 'story' ? text : ''); // keep the story draft safe until it's saved (BEA-512)
  const appendText = (chunk: string) => setText((t) => (t ? t + ' ' : '') + chunk);

  // When we reach the wrap-up step, load everything it needs: found tasks, a suggested hours figure,
  // and the day's unfinished tasks for carry-forward.
  useEffect(() => {
    if (step !== 'wrap' || candidates !== null) return;
    fetch('/api/daily/wrap-up-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day }) })
      .then((r) => (r.ok ? r.json() : { candidates: [], openTasks: [], suggestedMinutes: null }))
      .then((d) => {
        setCandidates(d.candidates || []);
        setOpenTasks(d.openTasks || []);
        if (d.suggestedMinutes && !hours) setHours((d.suggestedMinutes / 60).toFixed(1).replace(/\.0$/, ''));
      })
      .catch(() => setCandidates([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, candidates, day]);

  async function save() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/daily/story', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, mood: mood || undefined, day }) });
      if (r.ok) {
        const j = await r.json().catch(() => ({} as any));
        toast('success', j?.rewriting ? 'Story saved — rewriting that day’s Story of the Day ✨' : 'Story saved 🌙');
        if (j?.wrapped) toast('success', 'Wrapping up that day now — your Mentor and the Lab are updating (about a minute).');
        clearDraft(draftKey); // saved server-side — the local backup is no longer needed (BEA-512)
        onSaved();
        setStep('wrap'); // → wrap-up: finished tasks + working hours
      } else toast('error', (await r.json().catch(() => ({}))).message || 'Could not save');
    } catch {
      toast('error', 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function submitWrap(close: () => void) {
    setWrapBusy(true);
    try {
      const h = parseFloat(hours);
      const workedMinutes = Number.isFinite(h) && h > 0 ? Math.round(h * 60) : undefined;
      const roll = Object.entries(carry).filter(([, v]) => v === 'roll').map(([id]) => id);
      const drop = Object.entries(carry).filter(([, v]) => v === 'drop').map(([id]) => id);
      await fetch('/api/daily/wrap-up', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, tasks: candidates || [], workedMinutes, roll, drop }) });
      const n = candidates?.length || 0;
      toast('success', n ? `Logged ${n} finished task${n === 1 ? '' : 's'} ✓` : 'Day wrapped up ✓');
      onSaved();
      close();
    } catch {
      toast('error', 'Could not save the wrap-up');
    } finally {
      setWrapBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} canClose={() => !isDictating()} blockBackdropClose={() => text.trim().length > 0 || step === 'wrap'}>
      {(close) =>
        step === 'wrap' ? (
          <>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold flex items-center gap-2"><Sparkles className="text-emerald-500" size={18} /> Wrap up your day</h3>
              <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
            </div>

            {/* Finished tasks found in the story */}
            <div className="mb-4">
              <p className="text-xs text-zinc-500 mb-2">Finished tasks I spotted in your story (delete any that aren’t real, the rest get logged as done today):</p>
              {candidates === null ? (
                <div className="py-4 text-center text-sm text-zinc-400"><Loader2 size={16} className="animate-spin inline mr-2" /> Reading your story…</div>
              ) : candidates.length ? (
                <ul className="space-y-1.5">
                  {candidates.map((c, i) => (
                    <li key={i} className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-950/40 px-3 py-2">
                      <Check size={15} className="shrink-0 text-emerald-500" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{c.title}</div>
                        {c.category && <div className="text-[11px] text-zinc-400">{c.category}</div>}
                      </div>
                      <button onClick={() => setCandidates((arr) => (arr || []).filter((_, j) => j !== i))} aria-label="Remove" className="shrink-0 p-1 text-zinc-400 hover:text-rose-600"><X size={15} /></button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-zinc-400">No extra finished tasks found — nice and tidy.</p>
              )}
            </div>

            {/* Carry-forward — unfinished tasks */}
            {openTasks.length > 0 && (
              <div className="mb-4">
                <p className="text-xs text-zinc-500 mb-2">Still unfinished — carry forward or drop?</p>
                <ul className="space-y-1.5">
                  {openTasks.map((t) => {
                    const c = carry[t.id];
                    return (
                      <li key={t.id} className={'flex items-center gap-2 rounded-lg border px-3 py-2 ' + (c === 'drop' ? 'border-rose-300/60 dark:border-rose-500/30 opacity-60' : c === 'roll' ? 'border-emerald-400/60' : 'border-zinc-200 dark:border-zinc-800')}>
                        <div className={'min-w-0 flex-1 text-sm truncate ' + (c === 'drop' ? 'line-through text-zinc-400' : '')}>{t.title}</div>
                        <button onClick={() => setCarry((m) => ({ ...m, [t.id]: m[t.id] === 'roll' ? undefined : 'roll' }))} title="Roll to tomorrow" className={'shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ' + (c === 'roll' ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500')}>
                          <ArrowRight size={12} /> Tomorrow
                        </button>
                        <button onClick={() => setCarry((m) => ({ ...m, [t.id]: m[t.id] === 'drop' ? undefined : 'drop' }))} title="Drop" className={'shrink-0 p-1 rounded-md ' + (c === 'drop' ? 'text-rose-600' : 'text-zinc-400 hover:text-rose-600')}><Trash2 size={14} /></button>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-1 text-[11px] text-zinc-400">Leave untouched to keep them — they roll over on their own.</p>
              </div>
            )}

            {/* Working hours */}
            <div className="mb-4">
              <p className="text-xs text-zinc-500 mb-2 flex items-center gap-1.5"><Clock size={13} /> How many hours did you work today?</p>
              <div className="flex items-center gap-2 flex-wrap">
                {['4', '6', '8', '10'].map((h) => (
                  <button key={h} onClick={() => setHours(h)} className={'rounded-full border px-3 py-1 text-sm ' + (hours === h ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500')}>{h}h</button>
                ))}
                <div className="relative">
                  <input type="number" inputMode="decimal" min="0" max="24" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="e.g. 7.5" className="w-24 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-3 pr-7 py-1.5 text-sm outline-none focus:border-emerald-500" />
                  <span className="absolute right-2.5 top-1.5 text-xs text-zinc-400">h</span>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={close} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Skip</button>
              <button onClick={() => submitWrap(close)} disabled={wrapBusy || candidates === null} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">
                {wrapBusy ? 'Saving…' : 'Submit'}
              </button>
            </div>
          </>
        ) : (
          <>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold flex items-center gap-2"><Moon className="text-indigo-400" size={18} /> {title || "Tonight's story"}</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
          <p className="text-xs text-zinc-500 mb-3">Tell the story of your day — the problems, the wins, what happened. Type or speak it. This is how the app comes to understand you.</p>
          <div className="relative">
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder="Today started slow… the proposal took longer than I thought but I finally cracked the pricing section. Felt good. Skipped the gym again though…"
              className="w-full resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 pr-12 text-sm outline-none focus:border-indigo-500"
            />
            <DictateButton onText={appendText} className="absolute right-2 top-2" />
          </div>
          <div className="mt-3">
            <p className="text-xs text-zinc-500 mb-1.5">How did the day feel?</p>
            <div className="flex flex-wrap gap-2">
              {MOODS.map((m) => (
                <button key={m} onClick={() => setMood(mood === m ? '' : m)} className={'rounded-full border px-3 py-1 text-sm ' + (mood === m ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500')}>
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={close} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
            <button onClick={save} disabled={busy || !text.trim()} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 text-sm disabled:opacity-50">
              {busy ? 'Saving…' : 'Save story'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Nightly story card + daytime quick-notes, shown on the Today page. */
export function StorySection() {
  const [data, setData] = useState<DailyToday | null>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const toast = useToast();
  const appendNote = (chunk: string) => setNote((t) => (t ? t + ' ' : '') + chunk);

  async function load() {
    try {
      const r = await fetch('/api/daily/today');
      if (r.ok) setData(await r.json());
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function addNote() {
    if (!note.trim()) return;
    const r = await fetch('/api/daily/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: note }) });
    if (r.ok) {
      setNote('');
      load();
    } else toast('error', 'Could not save note');
  }
  async function delNote(id: string) {
    const r = await fetch(`/api/daily/note/${id}`, { method: 'DELETE' });
    if (r.ok) load();
  }

  const story = data?.story;
  const notes = data?.notes || [];

  return (
    <div className="space-y-3">
      {/* Daytime quick notes */}
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <h2 className="flex items-center gap-2 font-semibold text-sm mb-2"><MessageSquare size={15} className="text-emerald-500" /> Quick notes <span className="text-xs font-normal text-zinc-400">— capture what you're doing</span></h2>
        <div className="flex items-end gap-2">
          <GrowTextarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); } }}
            rows={1}
            placeholder="Speak or type a quick note…"
            className="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          <DictateButton onText={appendNote} />
          <button onClick={addNote} disabled={!note.trim()} className="p-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"><Plus size={16} /></button>
        </div>
        {notes.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {notes.map((n) => (
              <li key={n.id} className="group flex items-start gap-2 text-sm">
                <span className="text-[11px] text-zinc-400 tabular-nums pt-0.5 w-12 shrink-0">{timeOf(n.createdAt)}</span>
                <span className="flex-1 text-zinc-700 dark:text-zinc-300">{n.text}</span>
                <button onClick={() => delNote(n.id)} className="opacity-60 sm:opacity-0 sm:group-hover:opacity-100 p-0.5 text-zinc-400 hover:text-rose-600"><Trash2 size={13} /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Nightly story */}
      {story ? (
        <section className="rounded-xl border border-indigo-300/40 dark:border-indigo-500/30 bg-indigo-500/5 p-4">
          <div className="flex items-center justify-between mb-1.5">
            <h2 className="flex items-center gap-2 font-semibold text-sm"><BookOpen size={15} className="text-indigo-400" /> Tonight's story {story.mood && <span className="text-xs font-normal">· {story.mood}</span>}</h2>
            <button onClick={() => setEditing(true)} className="text-xs text-indigo-500 hover:underline">Edit</button>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap line-clamp-4">{story.text}</p>
        </section>
      ) : (
        <button onClick={() => setEditing(true)} className="w-full rounded-xl border border-dashed border-indigo-400/40 bg-indigo-500/5 hover:bg-indigo-500/10 p-4 text-left transition-colors flex items-center gap-3">
          <Moon className="text-indigo-400 shrink-0" size={22} />
          <div>
            <div className="font-semibold text-sm">🌙 Tell tonight's story</div>
            <p className="text-xs text-zinc-500">Your account of the day — type or speak it. This is how the AI learns who you are.</p>
          </div>
        </button>
      )}

      {editing && <StoryModal initial={story} onClose={() => setEditing(false)} onSaved={load} />}
    </div>
  );
}
