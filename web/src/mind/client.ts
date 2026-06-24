// "The Lab" client — the mini mental model's findings + the ✓/✗ review. (BEA-449/450)
export type Evidence = { id: string; signal: string; snippet: string | null; day: string };
export type Finding = {
  id: string;
  statement: string;
  kind: string; // emotional | behavioural | relational | temporal | causal
  subject: string;
  relation: string;
  object: string;
  valence: string; // energizing | draining | neutral
  confidence: number; // 0–1
  evidenceCount: number;
  status: string; // proposed | emerging | established | fading | retired
  cadence: string | null;
  trend: string; // rising | steady | fading
  validated: string | null;
  pinned: boolean;
  firstSeenDay: string;
  lastSeenDay: string;
  evidence?: Evidence[];
};

export type Stats = {
  moodSeries: { day: string; mood: number }[]; // mood 0–100, oldest→newest
  dowMood: { dow: number; avg: number | null; n: number }[]; // dow 0=Sun..6=Sat
  energizers: { id: string; label: string; statement: string; valence: string; strength: number; n: number }[];
  drainers: { id: string; label: string; statement: string; valence: string; strength: number; n: number }[];
  categories: { category: string; done: number; deferred: number; total: number; avoidance: number }[];
};

// The run-log: when the Lab learned / the morning wrap-up ran. (BEA-468)
export type MindRun = { id: string; at: string; kind: string; day: string | null; detail: string };
export type RunStatus = { runs: MindRun[]; lastLearn: MindRun | null; lastClose: MindRun | null; lastStory: MindRun | null; wrapAt: string };
// Holistic activity view — a per-day calendar + last-of-each status. (BEA-471)
export type DayRun = { day: string; story: boolean; wrapped: boolean; learned: boolean; mentor: boolean; summary: boolean };
export type RunStat = { at: string | null; detail: string | null };
export type Activity = {
  today: string;
  wrapAt: string;
  days: DayRun[];
  status: { story: RunStat; wrapped: RunStat; learned: RunStat; mentor: RunStat; summary: RunStat };
  runs: MindRun[];
};
// kind → plain label + accent, for the Activity log. (BEA-470)
export const RUN_KIND: Record<string, { label: string; tone: string }> = {
  learn: { label: 'Lab', tone: 'text-violet-500' },
  close: { label: 'Wrapped', tone: 'text-emerald-600 dark:text-emerald-400' },
  story: { label: 'Story', tone: 'text-indigo-500' },
  reminder: { label: 'Reminder', tone: 'text-amber-500' },
  wrap: { label: 'Wrapped', tone: 'text-emerald-600 dark:text-emerald-400' },
};

// The Situation model — Goal → Blocker → Lever chains. (BEA-515)
export type MindChain = {
  id: string;
  goal: string;
  blocker: string;
  lever: string;
  note: string | null;
  source: string; // user | engine
  status: string; // active | resolved | retired
  confidence: number;
  validated: string | null;
  pinned: boolean;
  shifted?: boolean; // engine re-derived the blocker on day-close (BEA-526) — UI asks "does this still fit?"
  createdAt: string;
  updatedAt: string;
};

const j = async <T>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};
const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then((r) => j(r));

export const mindApi = {
  review: () => fetch('/api/mind/review').then((r) => j<{ pending: Finding[]; fading: Finding[] }>(r)),
  findings: () => fetch('/api/mind/findings').then((r) => j<Finding[]>(r)),
  stats: () => fetch('/api/mind/stats').then((r) => j<Stats>(r)),
  confirm: (id: string) => post(`/api/mind/findings/${id}/confirm`),
  refute: (id: string) => post(`/api/mind/findings/${id}/refute`),
  amend: (id: string, patch: Partial<Pick<Finding, 'statement' | 'subject' | 'relation' | 'object' | 'valence'>>) =>
    fetch(`/api/mind/findings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => j(r)),
  pin: (id: string, pinned: boolean) => post(`/api/mind/findings/${id}/pin`, { pinned }),
  note: (id: string, text: string) => post(`/api/mind/findings/${id}/note`, { text }),
  remove: (id: string) => fetch(`/api/mind/findings/${id}`, { method: 'DELETE' }).then((r) => j(r)),
  run: (day?: string) => post('/api/mind/run', day ? { day } : {}),
  runs: () => fetch('/api/mind/runs').then((r) => j<RunStatus>(r)),
  activity: (days = 30) => fetch(`/api/mind/activity?days=${days}`).then((r) => j<Activity>(r)),
  getAbout: () => fetch('/api/mind/about').then((r) => j<{ text: string }>(r)),
  setAbout: (text: string) => fetch('/api/mind/about', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then((r) => j<{ text: string }>(r)),
};

// Situation chains API (BEA-515)
export const chainApi = {
  list: () => fetch('/api/mind/chains').then((r) => j<MindChain[]>(r)),
  create: (c: { goal: string; blocker: string; lever: string; note?: string }) => post('/api/mind/chains', c) as Promise<MindChain>,
  update: (id: string, patch: Partial<Pick<MindChain, 'goal' | 'blocker' | 'lever' | 'note' | 'status'>>) =>
    fetch(`/api/mind/chains/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => j(r)),
  confirm: (id: string) => post(`/api/mind/chains/${id}/confirm`),
  refute: (id: string) => post(`/api/mind/chains/${id}/refute`),
  resolve: (id: string) => post(`/api/mind/chains/${id}/resolve`),
  pin: (id: string, pinned: boolean) => post(`/api/mind/chains/${id}/pin`, { pinned }),
  remove: (id: string) => fetch(`/api/mind/chains/${id}`, { method: 'DELETE' }).then((r) => j(r)),
  parse: (text: string) => post('/api/mind/chains/parse', { text }) as Promise<{ goal: string; blocker: string; lever: string }>,
};

// kind → human group + accent, for the grouped review.
export const KIND_GROUP: Record<string, { label: string; emoji: string }> = {
  emotional: { label: 'Feelings', emoji: '💗' },
  behavioural: { label: 'Behaviour', emoji: '🔁' },
  causal: { label: 'Cause & effect', emoji: '🔗' },
  relational: { label: 'People', emoji: '🧑‍🤝‍🧑' },
  temporal: { label: 'Timing', emoji: '🕒' },
};
// How sure the Lab is, in plain words (BEA-462) — shown next to / instead of the raw %.
export function sureWord(confidence: number): string {
  const p = confidence <= 1 ? confidence * 100 : confidence; // accept 0–1 or 0–100
  if (p < 35) return 'Just a hunch';
  if (p < 60) return 'Fairly sure';
  if (p < 80) return 'Confident';
  return 'Very sure';
}

// The trust ladder (BEA-514): a clear rung instead of a bare %. Tapping ✓ (validated='confirmed') jumps it
// to the top rung so the user SEES it land. step 1..4.
export function trustRung(confidence: number, validated?: string | null): { label: string; step: number } {
  if (validated === 'confirmed') return { label: 'Confirmed by you', step: 4 };
  const p = confidence <= 1 ? confidence * 100 : confidence;
  if (p < 35) return { label: 'Just noticed', step: 1 };
  if (p < 60) return { label: 'Fairly sure', step: 2 };
  return { label: 'Confident', step: 3 };
}
// Shared date/time formatting for the run-log. (BEA-468)
export function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}
export function fmtRelative(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function valenceClass(v: string): string {
  return v === 'energizing'
    ? 'text-emerald-600 dark:text-emerald-400'
    : v === 'draining'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-zinc-500';
}
