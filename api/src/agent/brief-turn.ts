import {
  AI_LINES_MAX,
  BriefDelivery,
  BriefLine,
  BriefSections,
  BriefSource,
  LineOrigin,
  SECTION_KEYS,
  SectionKey,
  aiLineCount,
  emptyDelivery,
  emptySections,
  isSectionKey,
  live,
  sourceName,
} from './brief';

/**
 * What the builder proposes, and what is checked before he ever sees it (BEA-1424).
 *
 * ## Why this file exists
 *
 * Everything downstream of an approved brief was built and proven — finding any action, reading a
 * shape nobody has met, writing his exact message, showing him the real result before anything is
 * kept. And the **entrance was missing**: the conversation still produced the old eight-box plan, so
 * every brief up to now was filled in by hand through the API, by me. Which is the loop he asked to
 * end, still running.
 *
 * ## The checks are here, and they are mechanical
 *
 * The prompt asks for these things. The prompt is a request, and this builder has already shown four
 * times over that it will talk its way past a request. So each one is read out of the JSON and sent
 * back with a plain sentence — once per message, never in a loop.
 *
 * Pure. No Nest, no Prisma, no model.
 */

export type ProposedBrief = {
  name: string;
  sections: BriefSections;
  sources: BriefSource[];
  /** What it DOES with the information — writing, messaging. Empty for a job that only reads. */
  tools: string[];
  delivery: BriefDelivery;
};

/** What is wrong with it, in the words the model is sent back with. Empty = it may be shown to him. */
export type BriefProblem = { kind: 'too-long' | 'unlooked' | 'no-message' | 'no-success' | 'no-words' | 'nothing'; say: string };

const ORIGINS: LineOrigin[] = ['owner', 'tool', 'ai'];

/**
 * Read the model's `brief` field into the shape the store holds.
 *
 * Forgiving about how it writes: a section may be a list of strings (all treated as the AI's own
 * words, which is the safe direction) or a list of `{text, origin}`. Anything unreadable is dropped
 * rather than guessed at — a line nobody can attribute is worse than a missing line.
 */
export function readProposedBrief(raw: any): ProposedBrief | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sections = emptySections();
  const src = raw.sections && typeof raw.sections === 'object' ? raw.sections : {};
  let any = false;

  for (const k of SECTION_KEYS) {
    const v = (src as any)[k];
    if (!Array.isArray(v)) continue;
    for (const item of v) {
      const line = readLine(item);
      if (!line) continue;
      sections[k].push(line);
      any = true;
    }
  }
  if (!any) return null;

  return {
    name: String(raw.name || '').trim().slice(0, 120),
    sections,
    sources: readSources(raw.sources),
    tools: readToolIds(raw.tools),
    delivery: readDelivery(raw.delivery),
  };
}

function readLine(item: any): BriefLine | null {
  if (typeof item === 'string') {
    const text = item.trim();
    // A bare string is the model talking. Never assume his words — claiming his voice is the worse
    // mistake by far, and the tag is the whole point of the screen.
    return text ? { id: '', text, origin: 'ai' } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const text = String(item.text || '').trim();
  if (!text) return null;
  const origin = ORIGINS.includes(item.origin) ? (item.origin as LineOrigin) : 'ai';
  return {
    id: '',
    text,
    origin,
    ...(item.struck ? { struck: true } : {}),
    ...(item.evidence?.callId ? { evidence: { callId: String(item.evidence.callId) } } : {}),
  };
}

function readSources(raw: any): BriefSource[] {
  if (!Array.isArray(raw)) return [];
  const out: BriefSource[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const actionId = String(s.actionId || '').trim();
    if (!actionId) continue;
    out.push({
      id: String(s.id || actionId),
      actionId,
      args: s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? s.args : {},
      ...(s.pages === 'all' ? { pages: 'all' as const } : Number(s.pages) > 1 ? { pages: Number(s.pages) } : {}),
      ...(s.saw ? { saw: String(s.saw).slice(0, 400) } : {}),
    });
  }
  return out;
}

/** The actions it may use beyond its sources. Ids only; anything unreadable is dropped. */
function readToolIds(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    const id = String(typeof t === 'string' ? t : t?.actionId || t?.id || '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function readDelivery(raw: any): BriefDelivery {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    whatsapp: !!d.whatsapp,
    telegram: !!d.telegram,
    // Not trimmed: the leading and trailing shape of a message is part of the message.
    messageText: typeof d.messageText === 'string' ? d.messageText : '',
  };
}

/**
 * Everything wrong with the proposal, in the order worth fixing.
 *
 * `looked` is the set of action ids this conversation has really called — the sampler's own record,
 * never the model's claim about it.
 */
export function checkProposedBrief(b: ProposedBrief, looked: Set<string>): BriefProblem | null {
  if (!b.sources.length) {
    return { kind: 'nothing', say: 'This brief fetches nothing. Say where the information comes from, and look at it before you promise anything about it.' };
  }

  const unlooked = b.sources.filter((s) => !looked.has(s.actionId));
  if (unlooked.length) {
    const names = unlooked.map((s) => sourceName(s)).join(', ');
    return {
      kind: 'unlooked',
      say: `You have not looked at ${names} yourself. Call it once first — {"sample": {"actionId": "${unlooked[0].actionId}", "args": {…}}} — and write down what really came back. Do not promise him anything about a source you have not opened.`,
    };
  }

  const n = aiLineCount(b.sections);
  if (n > AI_LINES_MAX) {
    return {
      kind: 'too-long',
      say: `This brief has ${n} lines of your own in it, and ${AI_LINES_MAX} is the most it may hold — he has to be able to read the whole thing in one go. Cut it down to the ${AI_LINES_MAX} that matter, or ask him a question and let him tell you which ones are right.`,
    };
  }

  if (!live(b.sections.want).some((l) => l.origin === 'owner')) {
    return {
      kind: 'no-words',
      say: 'Nothing in "what I want" is in HIS words. Quote him — the line he actually said — and mark it origin "owner". A brief made entirely of your own guesses is not something he can check.',
    };
  }

  if ((b.delivery.whatsapp || b.delivery.telegram) && !b.delivery.messageText.trim()) {
    return {
      kind: 'no-message',
      say: 'You said it should message him and then wrote no message. Write the message out in full, exactly as it should arrive on his phone, with <angle brackets> where the real data goes. That text IS what gets sent — there is nowhere else for it to live.',
    };
  }

  if (!live(b.sections.success).length) {
    return {
      kind: 'no-success',
      say: 'Nothing says what a good run looks like. Ask him, in his words: how many, or what has to be in it. Without that nothing can tell a bad run from a good one, and a run that reads one email will call itself a success.',
    };
  }

  return null;
}

/** Did the model propose a brief this turn? */
export function briefRequestOf(g: any): any | null {
  const b = g?.brief;
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}

/** The short card in the chat — never the whole brief, which has its own screen. */
export function briefCardOf(b: ProposedBrief): { name: string; guesses: number; lines: number; sources: string[]; sends: boolean } {
  return {
    name: b.name || 'Your new agent',
    guesses: aiLineCount(b.sections),
    lines: SECTION_KEYS.reduce((n, k) => n + live(b.sections[k]).length, 0),
    sources: b.sources.map((s) => sourceName(s)),
    sends: !!(b.delivery.whatsapp || b.delivery.telegram),
  };
}

/** What the builder is told a brief IS. Kept beside the checks so the words and the code agree. */
export const BRIEF_TEXT = `WRITING THE BRIEF

When you understand the job, answer with a "brief" instead of a "plan". A brief is what he reads and
approves, and it is the only thing that gets built.

{"reply": "…", "brief": {
  "name": "Nightly email summary",
  "sections": {
    "want":    [{"text": "<his own sentence, quoted>", "origin": "owner"}],
    "sources": [{"text": "I looked at Gmail and got 47 emails, each with subject, from and date.", "origin": "tool"}],
    "filter":  [{"text": "Skip newsletters and receipts.", "origin": "ai"}],
    "output":  [{"text": "Save the full sorted list as a document.", "origin": "ai"}],
    "when":    [{"text": "Every weeknight at 9:30pm.", "origin": "owner"}],
    "success": [{"text": "At least 20 emails read, all three groups present.", "origin": "owner"}],
    "trouble": [{"text": "WhatsApp me and wait for my answer.", "origin": "owner"}]
  },
  "sources":  [{"actionId": "svc:gmail.fetch_emails", "args": {"query": "newer_than:1d"}, "pages": "all"}],
  "tools":    ["svc:notion.create_notion_page", "svc:notion.add_multiple_page_content"],
  "delivery": {"whatsapp": true, "telegram": false, "messageText": "Last night — <how many> important emails\\n\\nWORK\\n• <sender> — <one line>"}
}}

THE TAGS, and they matter more than anything else here:
  "owner" — HIS words, quoted. Never your paraphrase of them.
  "tool"  — something a real call actually showed. Only after you have called it.
  "ai"    — your own idea. He reads these first, because they are the ones that can be wrong.

THE RULES, which are checked in code and not left to you:
  1. LOOK BEFORE YOU PROMISE. Sample every source before you name it. Write what really came back.
  2. ${AI_LINES_MAX} LINES OF YOUR OWN, at most, across the whole brief. If you cannot say the job in
     ${AI_LINES_MAX} lines you do not understand it yet — ASK HIM A QUESTION instead of writing more.
     He will not read a wall of text, and a brief he does not read is worse than no brief.
  3. IF IT MESSAGES HIM, WRITE THE MESSAGE. In full, as it should arrive, with <angle brackets> where
     the real data goes. There is nowhere else for those words to live.
  4. SAY WHAT A GOOD RUN LOOKS LIKE, in his words. "At least 20 emails read." Without it, a run that
     reads one email calls itself a success — which is exactly what happened to him for weeks.
  5. "tools" IS NOT OPTIONAL when it does anything but read. A source is where information comes
     FROM; "tools" is what it does with it — the page it creates, the row it writes, the message it
     sends. **An action you do not list here, the agent cannot call.** List every one, by its exact
     id, fetched with "lookup" first.
  6. "pages": "all" means keep asking until the source runs out. Use it when he says "all" or
     "every"; a number is a guess about how much of his life fits on a page.

Nothing is built when you send a brief. He reads it, runs it once for real, and only then keeps it.`;

/**
 * Why no brief came, in his terms rather than the model's.
 *
 * He gets a sentence about what is still missing — not a half-written brief, and not the shrug that
 * cost him a night ("I couldn't work that out"). Each of these names the one thing to say next.
 */
export function briefHeldNote(p: BriefProblem): string {
  switch (p.kind) {
    case 'unlooked':
      return 'it has not actually opened the tools it wants to use yet, so anything it said about them would be a guess.';
    case 'too-long':
      return 'it was getting too long to read. Tell me the one or two things that matter most and I will keep it short.';
    case 'no-message':
      return 'it says it will message you but has not written what the message says. Tell me roughly what you want it to say.';
    case 'no-success':
      return 'nothing says what a good run looks like. Tell me what would make it worth having — a number, or what has to be in it.';
    case 'no-words':
      return 'it is all my guesses and none of your words. Say what you want in one sentence and I will use that.';
    default:
      return 'it does not fetch anything yet. Tell me where the information should come from.';
  }
}
