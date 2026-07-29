import { useEffect, useState } from 'react';
import { Check, Moon, X, Lock, ChevronLeft, ChevronRight, ChevronDown, Loader2, Sparkles, Clock, ArrowRight, Trash2, Radio, HeartPulse, CalendarDays, Lightbulb, Hand, Save } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import { DictateButton } from '../ui/DictateButton';
import { isDictating } from '../ui/useDictation';
import { clearDraft, loadObjectDraft, useObjectDraftPersist } from '../ui/useDraft';

/**
 * The ONE Close-the-day wizard (BEA-1052). The old world had two paths and only one asked the
 * questions — hours landed as zero and story work was skipped whenever the story came from EMO.
 * Now every close walks the same five steps, for today or ANY past day (sealed ones included):
 * ① story → ② everything the AI found → ③ hours (14h default) → ④ carry forward → ⑤ seal.
 */

type Mined = {
  /** The reply was cut off; what's shown is what survived. (BEA-1163) */
  partial?: boolean;
  day: string;
  hasStory: boolean;
  failed?: boolean;
  missing?: 'work' | 'day' | null; // one of the two reads came back empty (BEA-1166)
  cached?: boolean; // came from the stored reading — no wait, no call (BEA-1164)
  stale?: boolean; // the story was edited after this reading was made (BEA-1164)
  done: { title: string; category: string | null }[];
  todos: { title: string; category: string | null; note: string | null; priority: string }[];
  delegations: { contactName: string; contactId: string | null; title: string; chase: boolean }[];
  myReminders: { title: string; date: string | null }[];
  promises: { to: string; contactId: string | null; what: string; date: string | null }[];
  emotions: { lifted: string[]; drained: string[]; energy: number | null; worry: number | null; feeling: string | null } | null;
  events: { at: string | null; title: string }[];
  lessons: string[];
};

const MOODS = ['😣 Rough', '😐 Okay', '🙂 Good', '🤩 Great'];
const DEFAULT_HOURS = '14'; // the owner's default: a normal day is a 14-hour day (BEA-1053)

export function prettyDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

type StepId = 'story' | 'findings' | 'hours' | 'carry';
const STEPS: { id: StepId; label: string }[] = [
  { id: 'story', label: 'Story' },
  { id: 'findings', label: 'Found' },
  { id: 'hours', label: 'Hours' },
  { id: 'carry', label: 'Finished' }, // the step now closes tasks, not just carries them (BEA-1146)
];

/**
 * Everything the wizard is holding, so a crash costs him nothing. (BEA-1165)
 *
 * His words: *"can you also provide auto save option. if something goes wrong it has to save at the
 * exact position."* All of this used to live in browser memory alone — a reload, a dropped
 * connection or a swap to another app sent him back to a blank box.
 *
 * Kept on the device, deliberately. The moment things go wrong is usually the moment the network is
 * down, and a save that needs the server is no save at all.
 */
type Draft = {
  v: 1;
  /** Stamped by the auto-save hook when it writes, not by the wizard. */
  at: number;
  step: StepId;
  text: string;
  mood: string;
  hours: string;
  ticked: Record<string, boolean>;
  doneIds: Record<string, boolean>;
  carry: Record<string, 'drop' | undefined>;
};
const draftKey = (day: string) => `mybrain.draft.closeday.${day}`; // same prefix as the other drafts (BEA-512)

/** "saved 5 minutes ago" — plain words, so the resume line says how stale it is. */
export function savedAgo(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
/** Older than this and picking it up would be a surprise, not a rescue. */
const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function CloseDaySheet({ day, onClose, onClosed }: { day: string; onClose: () => void; onClosed: () => void }) {
  const toast = useToast();

  // Read synchronously, BEFORE the first render, so nothing he typed is shown as empty even for a
  // moment and the server load below knows not to overwrite it. (BEA-1165)
  const [saved] = useState<Draft | null>(() => {
    const d = loadObjectDraft<Draft>(draftKey(day));
    if (!d || d.v !== 1) return null;
    // Too old to be a rescue — picking it up would be a surprise. Delete it rather than leaving a
    // key behind for every day he ever opened. (BEA-1165)
    if (!d.at || Date.now() - d.at > DRAFT_MAX_AGE_MS) {
      clearDraft(draftKey(day));
      return null;
    }
    return d;
  });
  const [resumed, setResumed] = useState(!!saved);
  /** Once the day is sealed the draft is gone for good — never let a queued save bring it back. */
  const [sealed, setSealed] = useState(false);

  const [step, setStep] = useState<StepId>(saved?.step || 'story');
  const [busy, setBusy] = useState(false);

  // step 1 — story
  const [text, setText] = useState(saved?.text || '');
  const [mood, setMood] = useState(saved?.mood || '');
  const [storySavedText, setStorySavedText] = useState(''); // what's on the server, to avoid pointless saves
  const [isToday, setIsToday] = useState(true);
  const [wasClosed, setWasClosed] = useState(false);

  // step 2 — findings
  const [mined, setMined] = useState<Mined | null>(null);
  const [mineErr, setMineErr] = useState(false);
  // ticked[section:index] — everything starts ticked; unticking rejects a proposal
  const [ticked, setTicked] = useState<Record<string, boolean>>(saved?.ticked || {});

  // step 3 — hours
  const [hours, setHours] = useState(saved?.hours || DEFAULT_HOURS);

  // step 4 — what did you finish? (BEA-1146)
  type OpenTask = { id: string; title: string; carried: number; owner: string | null };
  const [openTasks, setOpenTasks] = useState<OpenTask[] | null>(null); // null = still loading or failed (BEA-1146)
  const [loadErr, setLoadErr] = useState(false);
  const [doneIds, setDoneIds] = useState<Record<string, boolean>>(saved?.doneIds || {}); // ticked = finished
  const [preTicked, setPreTicked] = useState<Record<string, boolean>>({}); // the story said so
  const [carry, setCarry] = useState<Record<string, 'drop' | undefined>>(saved?.carry || {});
  const [showOld, setShowOld] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState<OpenTask | null>(null);

  /** What the server has, kept so "Start fresh" can put everything back. (BEA-1165) */
  const [server, setServer] = useState<{ text: string; mood: string; hours: string }>({ text: '', mood: '', hours: DEFAULT_HOURS });

  useEffect(() => {
    fetch(`/api/daily/activity?day=${day}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((a) => {
        if (!a) return;
        setIsToday(!!a.isToday);
        setWasClosed(!!a.closed);
        const srvHours = a.stats?.workedMinutes ? String(Math.round((a.stats.workedMinutes / 60) * 10) / 10) : DEFAULT_HOURS;
        setServer({ text: a.story?.text || '', mood: a.story?.mood || '', hours: srvHours });
        if (a.story?.text) {
          // storySavedText is what the SERVER holds, always — it decides whether a save is needed
          // and whether the reading has to be asked for again. The draft must not fake it. (BEA-1165)
          setStorySavedText(a.story.text);
          if (!saved) {
            setText(a.story.text);
            if (a.story.mood) setMood(a.story.mood);
          }
        }
        if (!saved && a.stats?.workedMinutes) setHours(srvHours);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  // Auto-save, debounced. Stops once the day is sealed so a finished wizard leaves nothing behind.
  // No timestamp here on purpose: the hook stamps `at` when it actually writes. A Date.now() in this
  // object would change on every single render, so the debounce would restart forever and a busy
  // form would never save at all. (BEA-1165)
  useObjectDraftPersist(draftKey(day), { v: 1, step, text, mood, hours, ticked, doneIds, carry }, !sealed);

  /**
   * He restored onto a later step, so the findings he ticked are in `ticked` but the list they refer
   * to was never loaded — and `finish()` only applies findings when `mined` is present. Without this
   * a resumed wizard would seal the day and silently drop everything he had already approved.
   * The findings re-fetch is free: the reading is stored server-side. (BEA-1165, on top of BEA-1164)
   *
   * The last step needs its own reload too, or a resume straight onto it sits on skeleton rows
   * forever — nothing else ever asks for the open tasks.
   */
  useEffect(() => {
    if (!saved || saved.step === 'story') return;
    loadMine(false, true);
    if (saved.step === 'carry') toCarry(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Resumed onto a later step and the findings are still on their way back. Sealing now would drop
   *  every tick he made before the crash, silently — so the last button waits. (BEA-1165) */
  const findingsPending = !!saved && saved.step !== 'story' && !mined && !mineErr;
  const findingsLost = !!saved && saved.step !== 'story' && !mined && mineErr;

  /** Throw the draft away and go back to what the server has. */
  function startFresh() {
    clearDraft(draftKey(day));
    setResumed(false);
    setStep('story');
    setText(server.text);
    setMood(server.mood);
    setHours(server.hours);
    setTicked({});
    setDoneIds({});
    setCarry({});
    setMined(null);
    setMineErr(false);
  }

  const appendText = (chunk: string) => setText((t) => (t ? t + ' ' : '') + chunk);

  /** Step 1 → 2: save the story if it changed, then deep-mine it. */
  async function toFindings() {
    if (!text.trim()) {
      toast('error', 'Tell the story first — even a few lines. It drives everything after.');
      return;
    }
    // Captured BEFORE the save below overwrites storySavedText. If he went back and rewrote his
    // story, step 2 must ask the server again — otherwise it silently shows the pre-edit findings
    // and the "you changed your story" line never appears. The re-ask is free: the server hands
    // back the stored reading with `stale` set, and spends nothing. (BEA-1164)
    const storyChanged = text.trim() !== storySavedText.trim();
    setBusy(true);
    try {
      if (storyChanged || mood) {
        // noWrap: the wizard itself seals at the end — saving a past story must not auto-close mid-flow.
        const r = await fetch('/api/daily/story', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, mood: mood || undefined, day, noWrap: true }) });
        if (!r.ok) {
          toast('error', 'Could not save the story');
          return;
        }
        setStorySavedText(text);
      }
      setStep('findings');
      if (!mined || storyChanged) loadMine();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Deep-read the story. Separate so the honest Retry button can call it again.
   *
   * Without `force` the server hands back the reading it already has, instantly and free. `force` is
   * only ever set by HIM pressing "Read it again" — the app never decides on its own to spend
   * another call, which is the whole point of BEA-1164.
   */
  function loadMine(force = false, keepTicks = false) {
    setMineErr(false);
    setMined(null);
    fetch('/api/daily/mine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, force }) })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((m: Mined) => {
        setMined(m);
        const t: Record<string, boolean> = {};
        m.done.forEach((_, i) => (t[`done:${i}`] = true));
        m.todos.forEach((_, i) => (t[`todos:${i}`] = true));
        m.delegations.forEach((_, i) => (t[`delegations:${i}`] = true));
        m.myReminders.forEach((_, i) => (t[`myReminders:${i}`] = true));
        m.promises.forEach((_, i) => (t[`promises:${i}`] = true));
        m.events.forEach((_, i) => (t[`events:${i}`] = true));
        m.lessons.forEach((_, i) => (t[`lessons:${i}`] = true));
        if (m.emotions) t['emotions'] = true;
        // On a resume his own choices win — re-ticking everything would quietly undo the unticking
        // he had already done before the crash. (BEA-1165)
        if (!keepTicks) setTicked(t); // everything starts KEPT — unticking is the rejection
      })
      .catch(() => setMineErr(true));
  }

  /** Step 3 → 4: load the day's still-open tasks for carry choices. */
  async function toCarry(keepDone = false) {
    setStep('carry');
    if (!openTasks?.length) {
      setLoadErr(false);
      fetch('/api/daily/wrap-up-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day }) })
        .then((r) => { if (!r.ok) throw new Error('load failed'); return r.json(); })
        .then((d) => {
          setOpenTasks(d.openTasks || []);
          // Your story already said you did these — tick them, and say why. (BEA-1146)
          const pre: Record<string, boolean> = {};
          for (const id of d.finishedOpenIds || []) pre[id] = true;
          setPreTicked(pre);
          // On a resume his own ticks win — the story's guesses must not overwrite what he already
          // decided before the crash. (BEA-1165)
          if (!keepDone) setDoneIds(pre);
        })
        // A failed load used to fall through to "Nothing left open — clean sweep 🎉" with 44 tasks
        // still open. Sealing the day on that lie is worse than any error message. (BEA-1146)
        .catch(() => setLoadErr(true));
    }
  }

  /** The final act: apply the ticked findings, save hours + carry, seal the day. */
  async function finish(close: () => void) {
    setBusy(true);
    try {
      if (mined) {
        const pick = <T,>(section: string, list: T[]) => list.filter((_, i) => ticked[`${section}:${i}`]);
        const picked = {
          done: pick('done', mined.done),
          todos: pick('todos', mined.todos),
          delegations: pick('delegations', mined.delegations),
          myReminders: pick('myReminders', mined.myReminders),
          promises: pick('promises', mined.promises),
          events: pick('events', mined.events),
          lessons: mined.lessons.filter((_, i) => ticked[`lessons:${i}`]),
          emotions: ticked['emotions'] ? mined.emotions : null,
        };
        // Was: swallowed. Sealing on a failed apply loses every finding he ticked, and now also
        // clears the draft that held them — so a failure here must STOP, not carry on. (BEA-1165)
        const ok = await fetch('/api/daily/mine/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, picked }) })
          .then((r) => r.ok)
          .catch(() => false);
        if (!ok) {
          toast('error', "Couldn't save what you ticked — nothing was sealed, and your picks are safe. Try again.");
          return;
        }
      }
      const h = parseFloat(hours);
      const workedMinutes = Number.isFinite(h) && h > 0 ? Math.round(h * 60) : 14 * 60; // the box can be emptied, the day still gets hours
      const drop = Object.entries(carry).filter(([, v]) => v === 'drop').map(([id]) => id);
      const done = Object.entries(doneIds).filter(([, v]) => v).map(([id]) => id);
      const wrapped = await fetch('/api/daily/wrap-up', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, tasks: [], workedMinutes, roll: [], drop, done }) })
        .then((r) => r.ok)
        .catch(() => false);
      if (!wrapped) {
        toast('error', "Couldn't save your hours and finished tasks — nothing was sealed. Try again.");
        return;
      }
      const r = await fetch('/api/daily/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day }) });
      if (r.ok) {
        const j = await r.json().catch(() => ({} as any));
        const nClosed = Object.values(doneIds).filter(Boolean).length;
        const bits = [nClosed && `${nClosed} finished`, j.rolled && `${j.rolled} moved forward`].filter(Boolean).join(' · ');
        setSealed(true); // stop the auto-save BEFORE clearing, or a queued write puts it straight back
        clearDraft(draftKey(day)); // sealed for real — leave nothing behind to resume (BEA-1165)
        toast('success', wasClosed ? 'Day updated — its story and verdict are re-weaving ✨' : bits ? `Day sealed ✓ · ${bits}` : 'Day sealed ✓');
        onClosed();
        close();
      } else toast('error', 'Could not close the day');
    } finally {
      setBusy(false);
    }
  }

  const stepIdx = STEPS.findIndex((s) => s.id === step);
  const tickCount = Object.values(ticked).filter(Boolean).length;

  return (
    <>
    <Sheet onClose={onClose} canClose={() => !isDictating()} blockBackdropClose={() => true}>
      {(close) => (
        <>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-bold"><Lock size={16} className="text-emerald-500" /> {isToday ? 'Close today' : `Finish ${prettyDay(day)}`}</h3>
            <button onClick={close} aria-label="Close" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
          </div>
          {/* progress dots */}
          <div className="mb-4 flex items-center gap-1.5">
            {STEPS.map((s, i) => (
              <button key={s.id} onClick={() => i < stepIdx && setStep(s.id)} disabled={i > stepIdx}
                className={'h-1.5 flex-1 rounded-full transition-colors ' + (i < stepIdx ? 'bg-emerald-500' : i === stepIdx ? 'bg-emerald-500/60' : 'bg-zinc-200 dark:bg-zinc-800')} aria-label={s.label} />
            ))}
          </div>

          {/* Never restore silently. He should know why the box is not empty, and be one tap from a
              clean start. (BEA-1165) */}
          {resumed && (
            <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-emerald-300/50 bg-emerald-500/5 px-2.5 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400">
              <span className="inline-flex items-center gap-1.5"><Save size={13} /> Picking up where you left off{saved?.at ? ` — saved ${savedAgo(saved.at)}` : ''}.</span>
              <button onClick={startFresh} className="font-medium underline underline-offset-2 hover:text-emerald-900 dark:hover:text-emerald-300">Start fresh</button>
            </div>
          )}

          {step === 'story' && (
            <>
              <p className="mb-2 text-xs text-zinc-500 flex items-center gap-1.5"><Moon size={13} className="text-indigo-400" /> Your story of the day — everything after is read from it. EMO captures already land here.</p>
              <div className="relative">
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={9} autoFocus={!text}
                  placeholder="Morning at the factory… the QC batch cleared. Told Madhuri to send the report. Evening felt heavy — salaries still pending…"
                  className="w-full resize-y rounded-lg border border-zinc-300 bg-zinc-100 px-3 py-2 pr-12 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-950" />
                <DictateButton onText={appendText} className="absolute right-2 top-2" />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {MOODS.map((m) => (
                  <button key={m} onClick={() => setMood(mood === m ? '' : m)} className={'rounded-full border px-3 py-1 text-sm ' + (mood === m ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>{m}</button>
                ))}
              </div>
              <div className="mt-4 flex justify-end">
                <button onClick={toFindings} disabled={busy || !text.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                  {busy ? <Loader2 size={15} className="animate-spin" /> : null} Next <ChevronRight size={15} />
                </button>
              </div>
            </>
          )}

          {step === 'findings' && (
            <>
              <p className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500">
                <Sparkles size={13} className="text-emerald-500" />
                <span>Everything I found in your story — untick anything that's wrong. Nothing is created until the end.</span>
                {/* Saved from the last read, so reopening this step is instant and free. (BEA-1164) */}
                {mined?.cached && !mined.stale && (
                  <span className="inline-flex items-center gap-1 text-zinc-400">
                    Saved from earlier —
                    <button onClick={() => loadMine(true)} className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-200">read it again</button>
                  </span>
                )}
              </p>
              {mined === null && !mineErr ? (
                <div className="py-10 text-center text-sm text-zinc-400"><Loader2 size={18} className="mx-auto mb-2 animate-spin" /> Reading your story deeply — tasks, people, feelings, your whole day…</div>
              ) : mineErr || mined?.failed ? (
                <div className="rounded-lg border border-amber-300/50 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
                  The deep read failed — an AI hiccup, not a tidy day.
                  <button onClick={() => loadMine(true)} className="ml-2 rounded-md border border-amber-400/60 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/10">Try again</button>
                  <p className="mt-1 text-[11px]">You can also continue — only the automatic findings are skipped.</p>
                </div>
              ) : (
                <div className="max-h-[46vh] space-y-4 overflow-y-auto pr-1">
                  {/* He edited his story after this was read. The app deliberately does NOT re-run on
                      its own — "it should not run api calls repeatedly" — so it shows what it has and
                      hands him the button. (BEA-1164) */}
                  {mined.stale && (
                    <div className="rounded-lg border border-sky-300/50 bg-sky-500/5 p-2.5 text-xs text-sky-700 dark:border-sky-500/30 dark:text-sky-400">
                      You changed your story after I read this, so the list below is from the earlier version.
                      <button onClick={() => loadMine(true)} className="ml-1.5 font-medium underline underline-offset-2 hover:text-sky-900 dark:hover:text-sky-300">Read it again</button>
                    </div>
                  )}
                  {/* One half of the read came back empty. Half a day is worth showing — pretending
                      it is a whole one is not. (BEA-1166) */}
                  {mined.missing && (
                    <div className="rounded-lg border border-amber-300/50 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:border-amber-500/30 dark:text-amber-400">
                      {mined.missing === 'work'
                        ? "I got how your day felt, but not the work in it — no tasks or delegations below."
                        : "I got the work in your day, but not how it felt or what you did hour by hour."}
                      <button onClick={() => loadMine(true)} className="ml-1.5 font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-300">Read it again</button>
                    </div>
                  )}
                  {/* It was cut off and we kept what was complete. A silent gap in his day's record
                      is worse than a visible one — never let a partial read look tidy. (BEA-1163) */}
                  {mined.partial && (
                    <div className="rounded-lg border border-amber-300/50 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:border-amber-500/30 dark:text-amber-400">
                      That was a long day — I ran out of room and kept everything I'd read up to that point.
                      Some of the later part may be missing.
                      <button onClick={() => loadMine(true)} className="ml-1.5 underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-300">Read it again</button>
                    </div>
                  )}
                  <FindSection icon={<Check size={13} className="text-emerald-500" />} title="Finished (will be logged as done)" items={mined.done.map((d, i) => ({ key: `done:${i}`, main: d.title, sub: d.category }))} ticked={ticked} setTicked={setTicked} />
                  <FindSection icon={<ArrowRight size={13} className="text-sky-500" />} title="To-dos for you" items={mined.todos.map((t, i) => ({ key: `todos:${i}`, main: t.title, sub: [t.note, t.priority !== 'medium' ? t.priority : null].filter(Boolean).join(' · ') }))} ticked={ticked} setTicked={setTicked} />
                  <FindSection icon={<Radio size={13} className="text-amber-500" />} title="With your team (chased on WhatsApp)" items={mined.delegations.map((d, i) => ({ key: `delegations:${i}`, main: d.title, sub: d.contactId ? `${d.contactName} — daily chase 10:00 & 17:30` : `${d.contactName} — no matching contact, so no chase` }))} ticked={ticked} setTicked={setTicked} />
                  <FindSection icon={<Clock size={13} className="text-violet-500" />} title="Reminders for you" items={mined.myReminders.map((r, i) => ({ key: `myReminders:${i}`, main: r.title, sub: r.date }))} ticked={ticked} setTicked={setTicked} />
                  <FindSection icon={<Hand size={13} className="text-rose-500" />} title="Promises you made" items={mined.promises.map((p, i) => ({ key: `promises:${i}`, main: p.what, sub: `to ${p.to}${p.date ? ` · by ${p.date}` : ''}` }))} ticked={ticked} setTicked={setTicked} />
                  {mined.emotions && (
                    <section>
                      <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-500"><HeartPulse size={13} className="text-pink-500" /> How the day felt</h4>
                      <button onClick={() => setTicked((t) => ({ ...t, emotions: !t.emotions }))} className={'w-full rounded-lg border p-2.5 text-left text-xs ' + (ticked['emotions'] ? 'border-pink-400/50 bg-pink-500/5' : 'border-zinc-200 opacity-50 dark:border-zinc-800')}>
                        {mined.emotions.feeling && <p className="mb-1 text-sm">{mined.emotions.feeling}</p>}
                        <p className="text-zinc-500">
                          {mined.emotions.energy != null && <>energy {mined.emotions.energy} · </>}
                          {mined.emotions.worry != null && <>worry {mined.emotions.worry} · </>}
                          {mined.emotions.lifted.length > 0 && <>lifted by: {mined.emotions.lifted.join(', ')} </>}
                          {mined.emotions.drained.length > 0 && <>· drained by: {mined.emotions.drained.join(', ')}</>}
                        </p>
                      </button>
                    </section>
                  )}
                  <FindSection icon={<CalendarDays size={13} className="text-emerald-500" />} title="Your day, on the timeline" items={mined.events.map((e, i) => ({ key: `events:${i}`, main: e.title, sub: e.at }))} ticked={ticked} setTicked={setTicked} />
                  <FindSection icon={<Lightbulb size={13} className="text-amber-500" />} title="Lessons → The Lab" items={mined.lessons.map((l, i) => ({ key: `lessons:${i}`, main: l, sub: null }))} ticked={ticked} setTicked={setTicked} />
                  {!mined.done.length && !mined.todos.length && !mined.delegations.length && !mined.myReminders.length && !mined.promises.length && !mined.events.length && !mined.lessons.length && !mined.emotions && (
                    <p className="py-6 text-center text-sm text-zinc-400">Nothing new found — everything was already logged. Tidy day.</p>
                  )}
                </div>
              )}
              <WizardNav back={() => setStep('story')} next={() => setStep('hours')} nextDisabled={mined === null && !mineErr} nextLabel={mined ? `Keep ${tickCount} · Next` : 'Next'} />
            </>
          )}

          {step === 'hours' && (
            <>
              <p className="mb-3 text-xs text-zinc-500 flex items-center gap-1.5"><Clock size={13} /> How many hours did you work? Your default is 14 — just tap Next if that's right.</p>
              <div className="flex flex-wrap items-center gap-2">
                {['8', '10', '12', '14', '16'].map((h) => (
                  <button key={h} onClick={() => setHours(h)} className={'rounded-full border px-4 py-2 text-sm font-medium ' + (hours === h ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>{h}h</button>
                ))}
                <div className="relative">
                  <input type="number" inputMode="decimal" min="0" max="24" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} className="w-24 rounded-lg border border-zinc-300 bg-zinc-100 py-2 pl-3 pr-7 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950" />
                  <span className="absolute right-2.5 top-2 text-xs text-zinc-400">h</span>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-zinc-400">The AI splits the hours across what you actually did — you'll see it on the dashboard.</p>
              <WizardNav back={() => setStep('findings')} next={() => toCarry()} />
            </>
          )}

          {step === 'carry' && (
            <>
              {(() => {
                /**
                 * "What did you finish?" (BEA-1146)
                 *
                 * This step used to offer only Keep and a trash icon, so closing a day could never
                 * finish a task — the only way was to go to Tasks and tick it by hand. On the
                 * owner's real list that meant 49 open tasks, 38 of them carried a week or more,
                 * with the oldest at 48 days. Work he had genuinely done just kept ageing.
                 *
                 * Ticked = done. Untouched = carries forward, exactly as before. The default is
                 * still the safe one, so a rushed midnight close changes nothing by accident.
                 */
                const rows = openTasks ?? [];
                const recent = rows.filter((t) => t.carried < 7);
                const older = rows.filter((t) => t.carried >= 7);
                const dropped = (t: OpenTask) => carry[t.id] === 'drop';
                const nDone = Object.values(doneIds).filter(Boolean).length;

                const row = (t: OpenTask) => (
                  <li key={t.id} className={'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ' + (dropped(t) ? 'border-rose-300/60 opacity-50 dark:border-rose-500/30' : doneIds[t.id] ? 'border-emerald-400/70 bg-emerald-500/5' : 'border-zinc-200 dark:border-zinc-800')}>
                    <button
                      onClick={() => setDoneIds((m) => ({ ...m, [t.id]: !m[t.id] }))}
                      aria-label={doneIds[t.id] ? `Not finished: ${t.title}` : `Finished: ${t.title}`}
                      className={'mt-0.5 grid h-[19px] w-[19px] shrink-0 place-items-center rounded border transition-colors ' + (doneIds[t.id] ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-zinc-300 hover:border-emerald-500 dark:border-zinc-600')}
                    >
                      {doneIds[t.id] && <Check size={13} />}
                    </button>
                    <button onClick={() => setDoneIds((m) => ({ ...m, [t.id]: !m[t.id] }))} className="min-w-0 flex-1 text-left">
                      <span className={'block text-sm leading-snug ' + (dropped(t) ? 'text-zinc-400 line-through' : '')}>{t.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-400">
                        <span className="tabular-nums">{t.carried === 0 ? 'added today' : `carried ${t.carried} day${t.carried === 1 ? '' : 's'}`}</span>
                        {t.owner && <span className="text-amber-600 dark:text-amber-500">with {t.owner}</span>}
                        {preTicked[t.id] && <span className="text-emerald-600 dark:text-emerald-400">your story says you did this</span>}
                      </span>
                    </button>
                    <button onClick={() => (dropped(t) ? setCarry((m) => ({ ...m, [t.id]: undefined })) : setConfirmDrop(t))} title={dropped(t) ? 'Keep it after all' : 'Delete for good'} className={'mt-0.5 shrink-0 rounded-md p-1 ' + (dropped(t) ? 'text-rose-600' : 'text-zinc-400 hover:text-rose-600')}>
                      <Trash2 size={14} />
                    </button>
                  </li>
                );

                return (
                  <>
                    <p className="mb-3 text-xs text-zinc-500">
                      Tick what you finished — I'll mark those done. Anything you leave alone moves to tomorrow on its own.
                      {rows.some((t) => t.owner) && ' Closing one you gave to someone also stops their WhatsApp chase.'}
                    </p>

                    {loadErr ? (
                      <div className="rounded-lg border border-amber-300/50 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
                        I couldn’t load your open tasks, so I can’t show what to tick.
                        <button onClick={() => toCarry()} className="ml-2 rounded-md border border-amber-400/60 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/10">Try again</button>
                        <p className="mt-1 text-[11px]">Sealing now still carries everything forward — nothing is lost, and nothing gets marked done.</p>
                      </div>
                    ) : openTasks === null ? (
                      <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />)}</div>
                    ) : rows.length ? (
                      <div className="max-h-[42vh] space-y-3 overflow-y-auto pr-1">
                        {recent.length > 0 && (
                          <div>
                            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">This week · {recent.length}</div>
                            <ul className="space-y-1.5">{recent.map(row)}</ul>
                          </div>
                        )}
                        {older.length > 0 && (
                          <div>
                            <button onClick={() => setShowOld((v) => !v)} className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                              <ChevronDown size={13} className={'transition-transform ' + (showOld ? 'rotate-180' : '-rotate-90')} />
                              {older.length} older — carried 7+ days
                            </button>
                            {showOld && <ul className="space-y-1.5">{older.map(row)}</ul>}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="py-6 text-center text-sm text-zinc-400">Nothing left open — clean sweep. 🎉</p>
                    )}

                    {/* The picks he made before the crash could not be fetched back. Sealing now would
                        drop them without a word — say so, and give him the way to fix it. (BEA-1165) */}
                    {findingsLost && (
                      <div className="mt-3 rounded-lg border border-amber-300/50 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:border-amber-500/30 dark:text-amber-400">
                        I couldn't get back the findings you'd ticked earlier, so sealing now would skip them.
                        <button onClick={() => setStep('findings')} className="ml-1.5 font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-300">Go back and reload them</button>
                      </div>
                    )}

                    <div className="mt-4 flex items-center justify-between gap-2">
                      <button onClick={() => setStep('hours')} className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"><ChevronLeft size={15} /> Back</button>
                      <button onClick={() => finish(close)} disabled={busy || findingsPending} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                        {busy ? <><Loader2 size={15} className="animate-spin" /> Sealing…</> : findingsPending ? <><Loader2 size={15} className="animate-spin" /> Getting your picks back…</> : <><Lock size={15} /> {nDone ? `Close ${nDone} · ` : ''}{wasClosed ? 'Update this day' : 'Seal the day'} ✓</>}
                      </button>
                    </div>
                  </>
                );
              })()}
            </>
          )}

        </>
      )}
    </Sheet>

      {/* Deleting is permanent and sat one tap away from the tick box — it now asks first. (BEA-1146) */}
      <ConfirmDialog
        open={!!confirmDrop}
        title="Delete this task?"
        message={`“${confirmDrop?.title || ''}” will be deleted for good — this does not mark it finished, and it cannot be undone. To finish it instead, tick it.`}
        confirmLabel="Delete for good"
        onCancel={() => setConfirmDrop(null)}
        onConfirm={() => { if (confirmDrop) setCarry((m) => ({ ...m, [confirmDrop.id]: 'drop' })); setConfirmDrop(null); }}
      />
    </>
  );
}

function FindSection({ icon, title, items, ticked, setTicked }: { icon: React.ReactNode; title: string; items: { key: string; main: string; sub?: string | null }[]; ticked: Record<string, boolean>; setTicked: React.Dispatch<React.SetStateAction<Record<string, boolean>>> }) {
  if (!items.length) return null;
  return (
    <section>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-500">{icon} {title}</h4>
      <ul className="space-y-1.5">
        {items.map((it) => {
          const on = !!ticked[it.key];
          return (
            <li key={it.key}>
              <button onClick={() => setTicked((t) => ({ ...t, [it.key]: !t[it.key] }))} className={'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left ' + (on ? 'border-zinc-200 dark:border-zinc-800' : 'border-zinc-200 opacity-50 dark:border-zinc-800')}>
                <span className={'mt-0.5 grid h-4.5 w-4.5 h-[18px] w-[18px] shrink-0 place-items-center rounded border ' + (on ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-zinc-300 dark:border-zinc-600')}>{on && <Check size={12} />}</span>
                <span className="min-w-0">
                  <span className={'block text-sm ' + (on ? '' : 'line-through text-zinc-400')}>{it.main}</span>
                  {it.sub && <span className="block text-[11px] text-zinc-400">{it.sub}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function WizardNav({ back, next, nextDisabled, nextLabel }: { back: () => void; next: () => void; nextDisabled?: boolean; nextLabel?: string }) {
  return (
    <div className="mt-4 flex items-center justify-between gap-2">
      <button onClick={back} className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"><ChevronLeft size={15} /> Back</button>
      <button onClick={next} disabled={nextDisabled} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
        {nextLabel || 'Next'} <ChevronRight size={15} />
      </button>
    </div>
  );
}

/** Banner shown on Today when past days are still open — the gentle "finish yesterday" prompt. */
export function OpenDaysBanner({ onPick }: { onPick: (day: string) => void }) {
  const [days, setDays] = useState<{ day: string; openTasks: number; totalTasks: number; hasStory: boolean }[]>([]);
  useEffect(() => {
    fetch('/api/daily/open-days').then((r) => (r.ok ? r.json() : null)).then((j) => j && setDays(j.days || [])).catch(() => undefined);
  }, []);
  if (!days.length) return null;
  const d = days[0]; // most recent open day
  return (
    <button onClick={() => onPick(d.day)} className="w-full flex items-center gap-3 rounded-xl border border-amber-300/50 dark:border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10 p-3.5 text-left transition-colors">
      <span className="text-2xl shrink-0">📌</span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-sm">{prettyDay(d.day).replace(/^[A-Za-z]+, /, '')} is still open</div>
        <p className="text-xs text-zinc-500">{d.openTasks} to finish{days.length > 1 ? ` · +${days.length - 1} more day${days.length > 2 ? 's' : ''}` : ''} — close it so the story and mentor settle.</p>
      </div>
      <span className="shrink-0 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-300 px-3 py-1 text-xs font-medium">Finish →</span>
    </button>
  );
}

/**
 * "Fill a past day" — a proper button (not a weak link), the door back into ANY past day, sealed or
 * not. Tapping opens a native date picker; choosing a day launches the Close-day wizard. (BEA-1058)
 */
export function MissedDayPicker({ onPick }: { onPick: (day: string) => void }) {
  const yesterday = (() => { const d = new Date(Date.now() - 86400000); return d.toLocaleDateString('en-CA'); })();
  return (
    <label className="relative inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 text-sm font-medium text-zinc-600 transition-colors hover:border-emerald-500/50 hover:text-emerald-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-emerald-300">
      <CalendarDays size={15} /> Fill a past day you missed
      {/* the real date input sits invisibly over the button so a tap opens the calendar */}
      <input
        type="date"
        max={yesterday}
        onChange={(e) => { if (e.target.value) onPick(e.target.value); }}
        aria-label="Pick a past day to fill"
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </label>
  );
}
