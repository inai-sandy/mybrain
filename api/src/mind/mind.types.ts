// "The Lab" — the structured signals the mini mental model reasons over for a day. (BEA-446)

export type TaskSignal = {
  id: string;
  title: string;
  category: string | null;
  sphere: string; // work | personal
  priority: string;
  pinned: boolean;
  rolloverCount: number; // how many times it was deferred — the avoidance signal
  status: string;
};

export type WorkedSlice = { category: string; minutes: number };

export type StorySignal = {
  rawText: string;
  mood: string | null;
  workedMinutes: number | null;
  workedBreakdown: WorkedSlice[] | null;
};

export type IdeaSignal = { id: string; title: string; content: string };
export type EmailSignal = { from: string; subject: string; snippet: string };
export type MeetingSignal = { title: string; summary: string; decisions: string[] };

/** Everything the engine needs to model the user for one day — including INACTION (postpone/skip). */
export type DaySignals = {
  day: string;
  tasks: {
    done: TaskSignal[]; // completed that day
    skipped: TaskSignal[]; // planned for a past day, still open — abandoned
    postponed: TaskSignal[]; // chronically deferred (rolloverCount > 0) — the richest signal
    created: TaskSignal[]; // captured that day
    counts: { done: number; open: number; skipped: number; postponed: number; created: number };
  };
  story: StorySignal | null; // the day's story + mood (the feelings layer)
  daySummary: string | null; // the AI day summary
  ideas: IdeaSignal[];
  emails: EmailSignal[]; // that day's important emails (BEA-453)
  meetings: MeetingSignal[]; // that day's meetings (BEA-453)
  hasSignal: boolean; // false → nothing to reason about; engine should skip
};
