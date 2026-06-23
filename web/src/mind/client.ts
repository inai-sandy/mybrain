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
  remove: (id: string) => fetch(`/api/mind/findings/${id}`, { method: 'DELETE' }).then((r) => j(r)),
  run: (day?: string) => post('/api/mind/run', day ? { day } : {}),
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
export function valenceClass(v: string): string {
  return v === 'energizing'
    ? 'text-emerald-600 dark:text-emerald-400'
    : v === 'draining'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-zinc-500';
}
