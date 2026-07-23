import { useEffect, useState } from 'react';
import { Check, Moon, X, Lock, ChevronLeft, ChevronRight, Loader2, Sparkles, Clock, ArrowRight, Trash2, Radio, HeartPulse, CalendarDays, Lightbulb, Hand } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { DictateButton } from '../ui/DictateButton';
import { isDictating } from '../ui/useDictation';

/**
 * The ONE Close-the-day wizard (BEA-1052). The old world had two paths and only one asked the
 * questions — hours landed as zero and story work was skipped whenever the story came from EMO.
 * Now every close walks the same five steps, for today or ANY past day (sealed ones included):
 * ① story → ② everything the AI found → ③ hours (14h default) → ④ carry forward → ⑤ seal.
 */

type Mined = {
  day: string;
  hasStory: boolean;
  failed?: boolean;
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
  { id: 'carry', label: 'Carry' },
];

export function CloseDaySheet({ day, onClose, onClosed }: { day: string; onClose: () => void; onClosed: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<StepId>('story');
  const [busy, setBusy] = useState(false);

  // step 1 — story
  const [text, setText] = useState('');
  const [mood, setMood] = useState('');
  const [storySavedText, setStorySavedText] = useState(''); // what's on the server, to avoid pointless saves
  const [isToday, setIsToday] = useState(true);
  const [wasClosed, setWasClosed] = useState(false);

  // step 2 — findings
  const [mined, setMined] = useState<Mined | null>(null);
  const [mineErr, setMineErr] = useState(false);
  // ticked[section:index] — everything starts ticked; unticking rejects a proposal
  const [ticked, setTicked] = useState<Record<string, boolean>>({});

  // step 3 — hours
  const [hours, setHours] = useState(DEFAULT_HOURS);

  // step 4 — carry
  const [openTasks, setOpenTasks] = useState<{ id: string; title: string }[]>([]);
  const [carry, setCarry] = useState<Record<string, 'roll' | 'drop' | undefined>>({});

  useEffect(() => {
    fetch(`/api/daily/activity?day=${day}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((a) => {
        if (!a) return;
        setIsToday(!!a.isToday);
        setWasClosed(!!a.closed);
        if (a.story?.text) {
          setText(a.story.text);
          setStorySavedText(a.story.text);
          if (a.story.mood) setMood(a.story.mood);
        }
        if (a.stats?.workedMinutes) setHours(String(Math.round((a.stats.workedMinutes / 60) * 10) / 10));
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  const appendText = (chunk: string) => setText((t) => (t ? t + ' ' : '') + chunk);

  /** Step 1 → 2: save the story if it changed, then deep-mine it. */
  async function toFindings() {
    if (!text.trim()) {
      toast('error', 'Tell the story first — even a few lines. It drives everything after.');
      return;
    }
    setBusy(true);
    try {
      if (text.trim() !== storySavedText.trim() || mood) {
        // noWrap: the wizard itself seals at the end — saving a past story must not auto-close mid-flow.
        const r = await fetch('/api/daily/story', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, mood: mood || undefined, day, noWrap: true }) });
        if (!r.ok) {
          toast('error', 'Could not save the story');
          return;
        }
        setStorySavedText(text);
      }
      setStep('findings');
      if (!mined) loadMine();
    } finally {
      setBusy(false);
    }
  }

  /** Deep-read the story. Separate so the honest Retry button can call it again. */
  function loadMine() {
    setMineErr(false);
    setMined(null);
    fetch('/api/daily/mine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day }) })
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
        setTicked(t); // everything starts KEPT — unticking is the rejection
      })
      .catch(() => setMineErr(true));
  }

  /** Step 3 → 4: load the day's still-open tasks for carry choices. */
  async function toCarry() {
    setStep('carry');
    if (!openTasks.length) {
      fetch('/api/daily/wrap-up-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day }) })
        .then((r) => (r.ok ? r.json() : { openTasks: [] }))
        .then((d) => setOpenTasks(d.openTasks || []))
        .catch(() => undefined);
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
        await fetch('/api/daily/mine/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, picked }) }).catch(() => undefined);
      }
      const h = parseFloat(hours);
      const workedMinutes = Number.isFinite(h) && h > 0 ? Math.round(h * 60) : 14 * 60; // the box can be emptied, the day still gets hours
      const roll = Object.entries(carry).filter(([, v]) => v === 'roll').map(([id]) => id);
      const drop = Object.entries(carry).filter(([, v]) => v === 'drop').map(([id]) => id);
      await fetch('/api/daily/wrap-up', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day, tasks: [], workedMinutes, roll, drop }) }).catch(() => undefined);
      const r = await fetch('/api/daily/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day }) });
      if (r.ok) {
        const j = await r.json().catch(() => ({} as any));
        toast('success', wasClosed ? 'Day updated — its story and verdict are re-weaving ✨' : j.rolled ? `Day sealed ✓ · ${j.rolled} unfinished moved forward` : 'Day sealed ✓');
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
              <p className="mb-3 text-xs text-zinc-500 flex items-center gap-1.5"><Sparkles size={13} className="text-emerald-500" /> Everything I found in your story — untick anything that's wrong. Nothing is created until the end.</p>
              {mined === null && !mineErr ? (
                <div className="py-10 text-center text-sm text-zinc-400"><Loader2 size={18} className="mx-auto mb-2 animate-spin" /> Reading your story deeply — tasks, people, feelings, your whole day…</div>
              ) : mineErr || mined?.failed ? (
                <div className="rounded-lg border border-amber-300/50 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
                  The deep read failed — an AI hiccup, not a tidy day.
                  <button onClick={loadMine} className="ml-2 rounded-md border border-amber-400/60 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/10">Try again</button>
                  <p className="mt-1 text-[11px]">You can also continue — only the automatic findings are skipped.</p>
                </div>
              ) : (
                <div className="max-h-[46vh] space-y-4 overflow-y-auto pr-1">
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
              <WizardNav back={() => setStep('findings')} next={toCarry} />
            </>
          )}

          {step === 'carry' && (
            <>
              <p className="mb-3 text-xs text-zinc-500">Still unfinished — everything moves forward on its own. Drop what no longer matters.</p>
              {openTasks.length ? (
                <ul className="max-h-[40vh] space-y-1.5 overflow-y-auto pr-1">
                  {openTasks.map((t) => {
                    const c = carry[t.id];
                    return (
                      <li key={t.id} className={'flex items-center gap-2 rounded-lg border px-3 py-2 ' + (c === 'drop' ? 'border-rose-300/60 opacity-60 dark:border-rose-500/30' : c === 'roll' ? 'border-emerald-400/60' : 'border-zinc-200 dark:border-zinc-800')}>
                        <div className={'min-w-0 flex-1 truncate text-sm ' + (c === 'drop' ? 'text-zinc-400 line-through' : '')}>{t.title}</div>
                        <button onClick={() => setCarry((m) => ({ ...m, [t.id]: m[t.id] === 'roll' ? undefined : 'roll' }))} title="Carry forward" className={'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] ' + (c === 'roll' ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 text-zinc-500 hover:border-emerald-500 dark:border-zinc-700')}>
                          <ArrowRight size={12} /> Keep
                        </button>
                        <button onClick={() => setCarry((m) => ({ ...m, [t.id]: m[t.id] === 'drop' ? undefined : 'drop' }))} title="Drop" className={'shrink-0 rounded-md p-1 ' + (c === 'drop' ? 'text-rose-600' : 'text-zinc-400 hover:text-rose-600')}><Trash2 size={14} /></button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="py-6 text-center text-sm text-zinc-400">Nothing left open — clean sweep. 🎉</p>
              )}
              <div className="mt-4 flex items-center justify-between gap-2">
                <button onClick={() => setStep('hours')} className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"><ChevronLeft size={15} /> Back</button>
                <button onClick={() => finish(close)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                  {busy ? <><Loader2 size={15} className="animate-spin" /> Sealing…</> : <><Lock size={15} /> {wasClosed ? 'Update this day' : 'Close the day'} ✓</>}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
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

/** "Fill a missed day" — the door back into ANY past day, sealed or not. (BEA-1052) */
export function MissedDayPicker({ onPick }: { onPick: (day: string) => void }) {
  const [open, setOpen] = useState(false);
  const yesterday = (() => { const d = new Date(Date.now() - 86400000); return d.toLocaleDateString('en-CA'); })();
  return (
    <div className="text-center">
      {open ? (
        <div className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 p-2 dark:border-zinc-800">
          <input type="date" max={yesterday} onChange={(e) => { if (e.target.value) { onPick(e.target.value); setOpen(false); } }}
            className="rounded-lg border border-zinc-300 bg-zinc-100 px-2 py-1.5 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-950" />
          <button onClick={() => setOpen(false)} className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={15} /></button>
        </div>
      ) : (
        <button onClick={() => setOpen(true)} className="text-xs text-zinc-400 underline-offset-2 hover:text-emerald-600 hover:underline">
          Missed a day? Fill its story from here
        </button>
      )}
    </div>
  );
}
