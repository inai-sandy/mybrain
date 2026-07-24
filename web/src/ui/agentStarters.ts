import type { Depth } from './DepthDial';

/**
 * Starter agent templates (BEA-697, rebuilt BEA-1064) — complete, runnable agents pre-wired to the
 * user's REAL brain: their plans start from search_brain (their journal, tasks, bookmarks, people),
 * so the very first run produces THEIR result, not a demo.
 */
export type Starter = {
  key: string;
  name: string;
  icon: string;
  color: string;
  category: 'Daily' | 'Research' | 'People' | 'Brain care' | 'Other';
  blurb: string;
  examples: string[];
  task: string;
  rubric: string;
  autonomy: 'cautious' | 'balanced' | 'autopilot';
  depth: Depth;
  every?: 'manual' | 'day' | 'weekday' | 'week' | 'hour';
  at?: string;
};

export const STARTERS: Starter[] = [
  {
    key: 'morning-brief',
    name: 'Morning Brief',
    icon: '🌅',
    color: '#818cf8',
    category: 'Daily',
    blurb: 'Your journal + today, briefed while you wake up.',
    examples: ['“Yesterday you closed the vendor question…”', '“3 tasks due — the handoff doc matters most”'],
    depth: 'standard',
    autonomy: 'autopilot',
    every: 'day',
    at: '07:00',
    task: '1. Use search_brain to read my journal entry from last night and my open tasks for today.\n2. Pick out what actually matters: the one real job of the day, anything urgent, and any promise that lands today.\n3. Write a short brief in plain English — a one-line headline, then a few bullets.\n4. Use save_document to save it titled "Morning Brief — <date>".',
    rubric: '- Opens with a one-line headline about MY day\n- Under 8 bullets, plain English\n- Flags anything urgent or promised for today first\n- Uses my real journal and tasks, not generic advice',
  },
  {
    key: 'research',
    name: 'Research & Save',
    icon: '🔬',
    color: '#22d3ee',
    category: 'Research',
    blurb: 'Deep-dive any topic into a cited brief in your Documents.',
    examples: ['“Best solar water heater for a 3-floor home”', '“LoRa vs BLE for a wearable”'],
    depth: 'deep',
    autonomy: 'balanced',
    task: '1. Use search_brain to check what I have already saved about the topic.\n2. Research the topic on the web properly — several sources, not one search.\n3. Write a clear brief: the answer first, then the reasoning, with sources cited inline.\n4. Use save_document to save it.',
    rubric: '- Covers the topic in depth with specific facts\n- Cites its sources inline\n- Reconciles with anything I had already saved\n- Ends with a short takeaway',
  },
  {
    key: 'weekly-digest',
    name: 'Weekly Journal Digest',
    icon: '📰',
    color: '#a78bfa',
    category: 'Daily',
    blurb: 'Every Sunday, your week retold in one page.',
    examples: ['“A week of shipping: the watch, the RFQs…”', '“Mood climbed after Tuesday — here’s why”'],
    depth: 'standard',
    autonomy: 'autopilot',
    every: 'week',
    at: '08:00',
    task: '1. Use search_brain to read my journal entries and day summaries from the last 7 days.\n2. Find the through-line: what the week was really about, what moved, what slipped, how the mood ran.\n3. Write it as one readable page — story first, then 3 bullets of "carry into next week".\n4. Use save_document to save it titled "Week digest — <date>".',
    rubric: '- Reads like a story of MY week, with my real names and events\n- One page, plain English\n- Ends with 3 concrete carry-forwards\n- No invented events',
  },
  {
    key: 'remind-contact',
    name: 'Remind a Contact',
    icon: '📣',
    color: '#34d399',
    category: 'People',
    blurb: 'Finds who went quiet and drafts the nudges — you approve each.',
    examples: ['“Jayanth is 3 days quiet on the samples”', '“Draft ready: OK to send?”'],
    depth: 'standard',
    autonomy: 'cautious',
    task: '1. Use search_brain to find my delegated tasks and who owns them, plus anything I said about deadlines.\n2. Work out who has gone quiet or is past their promised date.\n3. For each, draft a short friendly nudge in my voice.\n4. Use ask_user with the draft to check EACH message with me before anything else — never assume a send.\n5. Use save_document to save a "chase sheet" of who was nudged and who is on track.',
    rubric: '- Only flags people who are genuinely quiet or late\n- Drafts sound like me: short, warm, no pressure\n- Every draft was checked with me first\n- Ends with a clear chase sheet',
  },
  {
    key: 'bookmark-triage',
    name: 'Bookmark Triage',
    icon: '🔖',
    color: '#f472b6',
    category: 'Brain care',
    blurb: 'Sorts your latest saves into tidy folders with one-liners.',
    examples: ['“6 new saves → AI (4), Hardware (2)”', '“Worth reading first: the pgvector post”'],
    depth: 'standard',
    autonomy: 'balanced',
    task: '1. Use search_brain to find my recent bookmarks and their summaries.\n2. Group them into a few BROAD folders (like AI, Hardware, Business) — never one folder per link.\n3. For each, write a one-line "why it was worth saving" and pick the one most worth reading first.\n4. Use save_document to save the triage as "Bookmark triage — <date>".',
    rubric: '- Broad folders, not dozens of tiny ones\n- One honest line per bookmark\n- Names the single most worth-it read\n- Uses my real bookmarks',
  },
  {
    key: 'brain-hygiene',
    name: 'Brain Hygiene',
    icon: '🧹',
    color: '#c084fc',
    category: 'Brain care',
    blurb: 'Flags duplicates & stale notes — asks before touching anything.',
    examples: ['“These 3 look like the same EMO idea — merge?”', '“6 notes untouched for 6 months”'],
    depth: 'standard',
    autonomy: 'cautious',
    every: 'week',
    at: '08:30',
    task: '1. Use search_brain across my notes and documents to spot likely duplicates (same idea saved twice) and stale items (old, unfinished, never mentioned again).\n2. NEVER delete or change anything yourself.\n3. Use ask_user to propose each cleanup ("these look like duplicates — merge? this looks stale — archive?") with choices.\n4. Use save_document to save a short tidy-up report of what I decided.',
    rubric: '- Finds real duplicates/stale items, not false alarms\n- Touches nothing without my answer\n- Proposals are one-tap choices\n- Ends with a clear report',
  },
  {
    key: 'reply',
    name: 'Draft a Reply',
    icon: '✍️',
    color: '#fbbf24',
    category: 'People',
    blurb: 'Draft a reply or message in my plain voice.',
    examples: ['“Reply to the vendor asking for 2 more weeks”'],
    depth: 'standard',
    autonomy: 'balanced',
    task: '1. Use search_brain for any context about the person or thread I mention.\n2. Draft a clear, polite reply in simple plain English, in my voice.\n3. Show me the draft — do not send anything.',
    rubric: '- Matches what was asked\n- Plain, warm, concise\n- Ready to send',
  },
  {
    key: 'summarize',
    name: 'Summarize a Link',
    icon: '🔗',
    color: '#38bdf8',
    category: 'Research',
    blurb: 'Give a URL, get a tight summary.',
    examples: ['“What’s this 40-min video actually saying?”'],
    depth: 'quick',
    autonomy: 'autopilot',
    task: 'Read the link I give you and return a tight summary: what it is, the key points, and why it matters to me (check search_brain for related notes).',
    rubric: '- Under ~6 bullets\n- Captures the key points\n- No filler',
  },
];
