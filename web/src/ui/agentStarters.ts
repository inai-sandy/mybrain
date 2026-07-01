import type { Depth } from './DepthDial';

/** Starter agent templates (BEA-697) — preset task + Outcome + depth so "New agent" isn't a blank box. */
export type Starter = {
  key: string;
  name: string;
  icon: string;
  blurb: string;
  task: string;
  rubric: string;
  depth: Depth;
  every?: 'manual' | 'day' | 'weekday' | 'hour';
  at?: string;
};

export const STARTERS: Starter[] = [
  {
    key: 'research',
    name: 'Research & Save',
    icon: '🔬',
    blurb: 'Deep-dive a topic into a cited brief, saved to Documents.',
    depth: 'deep',
    task: 'Research the topic I give you thoroughly and write a clear, well-structured brief with sources.',
    rubric: '- Covers the topic in depth with specific facts\n- Cites its sources inline\n- Clear structure, no fluff\n- Ends with a short takeaway',
  },
  {
    key: 'brief',
    name: 'Daily Brief',
    icon: '📰',
    blurb: 'Each morning, summarise what matters into a short brief.',
    depth: 'standard',
    every: 'day',
    at: '07:00',
    task: 'Summarise what matters for me today (unread emails, calendar, open tasks) into a short brief, flagging anything urgent.',
    rubric: '- Short (under ~8 bullets)\n- Flags anything urgent first\n- Plain English',
  },
  {
    key: 'reply',
    name: 'Draft a Reply',
    icon: '✍️',
    blurb: 'Draft a reply or message in my plain voice.',
    depth: 'standard',
    task: 'Draft a clear, polite reply/message for the situation I describe, in simple plain English.',
    rubric: '- Matches what was asked\n- Plain, warm, concise\n- Ready to send',
  },
  {
    key: 'summarize',
    name: 'Summarize a Link',
    icon: '🔗',
    blurb: 'Give a URL, get a tight summary.',
    depth: 'quick',
    task: 'Read the link I give you and return a tight summary: what it is, the key points, and why it matters.',
    rubric: '- Under ~6 bullets\n- Captures the key points\n- No filler',
  },
];
