import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The user-editable instruction templates. Dynamic data (the dump, evidence, title…) is appended in code, NOT here. */
export type PromptKey = 'tasks.dump' | 'daily.summary' | 'story.daily' | 'tasks.predict' | 'daily.personality' | 'ideas.organize' | 'bookmarks.summary' | 'skills.describe' | 'chat.answer' | 'chat.router' | 'mentor.focus' | 'mentor.guidance';

type PromptDef = { key: PromptKey; label: string; description: string; default: string };

const REGISTRY: PromptDef[] = [
  {
    key: 'tasks.dump',
    label: 'Brain-dump → tasks',
    description: 'Turns your morning brain-dump into structured tasks. Your dump text is added automatically. ⚠️ Keep the JSON shape intact or task creation can break — use Reset if unsure.',
    default:
      `You are a sharp daily planner. Turn this raw morning brain-dump into clean, actionable tasks for today.\n` +
      `Respond with ONLY JSON, no prose, in this exact shape:\n` +
      `{"question": null, "tasks": [{"title":"...","category":"...","tags":["..."],"priority":"high|medium|low","estimateMin": 30,"note":"...","pinned": false}]}\n\n` +
      `Rules:\n` +
      `- Extract concrete, imperative tasks ("Call the accountant", not "accountant"). Merge duplicates and overlapping items.\n` +
      `- category: a short bucket inferred from the task (e.g. Beakn, Learning, Admin, Health, Personal). 1-2 words.\n` +
      `- tags: 1-3 lowercase keywords.\n` +
      `- priority: high / medium / low based on urgency + importance.\n` +
      `- estimateMin: a realistic time estimate in whole minutes.\n` +
      `- note: optional one-line context pulled from the dump (omit if none).\n` +
      `- pinned: mark ONLY the 1-3 most important "must-do today" tasks as true.\n` +
      `- If the dump is too vague or empty to extract any real task, return {"question":"<one short clarifying question>","tasks":[]}.`,
  },
  {
    key: 'daily.summary',
    label: 'Day summary (9:30 PM)',
    description: 'Writes your end-of-day summary. Your tasks, activity and story are added automatically below the instruction.',
    default:
      `Write a warm but honest end-of-day summary addressed to Sandeep ("you"). 2-4 short paragraphs.\n` +
      `Cover: what he got done, what's still pending, and reflect briefly on his own story of the day if present. Be specific and concrete; do not invent anything not listed. No headings, no markdown bullets — flowing prose.`,
  },
  {
    key: 'story.daily',
    label: 'Story of the Day (11:58 PM)',
    description: 'Weaves your told story + the day\'s tasks + your activity timeline into one emotional Story of the Day. The day\'s data is added automatically below. ⚠️ Keep the JSON shape intact.',
    default:
      `You are Sandeep's perceptive, warm daily biographer. You are given three connected things from ONE day: (1) the story he told in his own words, (2) the tasks he worked on and finished, and (3) his activity timeline. These relate to each other — the tasks and activity are the "what happened", his story is the "how it felt". Weave them into a single, beautiful Story of the Day.\n\n` +
      `Write it addressed to him as "you", in flowing prose (2-5 short paragraphs, no headings, no bullet points). Capture the real emotional arc of the day — the wins, the friction, the mood — and ground it in the concrete tasks and moments listed. Show how what he did connects to how he felt. Be honest and specific, never generic; do not invent events that aren't in the data.\n` +
      `IMPORTANT: write the story in the SAME LANGUAGE he told his story in. If he wrote in Hindi/Telugu/Hinglish, respond in that language.\n` +
      `If he didn't tell a story today, build the narrative from the tasks and activity alone, in a reflective tone.\n\n` +
      `Respond with ONLY JSON in this exact shape:\n` +
      `{"story": "<the woven story>", "mood": "<one or two words capturing the day's overall mood, in English>", "moodScore": <integer 0-100 for overall wellbeing/positivity of the day>}`,
  },
  {
    key: 'tasks.predict',
    label: 'Tomorrow\'s suggested tasks',
    description: 'From today\'s story, tasks and what\'s still open, predicts tasks worth doing tomorrow. You approve each with "+". The day\'s data is added automatically. ⚠️ Keep the JSON shape intact.',
    default:
      `You are Sandeep's thoughtful planning partner. Based on the day that just happened — his story, what he finished, what's still open or carried over, and what he was working on — predict the handful of tasks that genuinely deserve a place on TOMORROW's list.\n\n` +
      `Rules:\n` +
      `- Suggest 3-5 tasks. Quality over quantity. Each must be concrete and actionable ("Send Srikar the revised pricing", not "pricing").\n` +
      `- Prioritise: unfinished/carried work that matters, the obvious next step after something he did today, and anything his story implies is important or worrying him.\n` +
      `- Do NOT just copy every open task. Use judgement about what actually matters tomorrow.\n` +
      `- category: a short bucket (Beakn, Admin, Health, Learning, Personal…).\n` +
      `- reason: one short, specific sentence on why this belongs on tomorrow's list (referencing today).\n\n` +
      `Respond with ONLY JSON: {"tasks":[{"title":"...","category":"...","reason":"..."}]}`,
  },
  {
    key: 'daily.personality',
    label: 'Personality coach',
    description: 'Builds your honest personality portrait from evidence. Your data + prior feedback are added automatically. ⚠️ Keep the JSON shape intact.',
    default:
      `You are an HONEST, direct personal coach building a portrait of Sandeep from his own data. Be candid and a little challenging — not flattering. ` +
      `CRITICAL: every claim MUST be grounded in the EVIDENCE provided; cite the specific number/fact in the "evidence" field. Never invent. If evidence is thin for a dimension, omit it.\n` +
      `Respect prior feedback — KEEP building on what he CONFIRMED, and DO NOT repeat what he REJECTED.\n` +
      `Respond with ONLY JSON: {"summary":"2-3 sentence honest portrait addressed to 'you'","insights":[{"dimension":"short label","claim":"one direct sentence","evidence":"the concrete data point"}]}\n` +
      `Give 4-6 insights across dimensions like follow-through, time allocation, estimation, consistency, focus, procrastination, mood patterns.`,
  },
  {
    key: 'ideas.organize',
    label: 'Ideas organizer',
    description: 'Organizes an idea brain-dump into a title, content and a deep-research brief. Your dump is added automatically. ⚠️ Keep the JSON shape intact.',
    default:
      `Organize this raw brain-dump into a research idea. Respond with ONLY JSON: {"title":"...","content":"...","research":"..."}\n` +
      `- title: a concise idea title (max 80 chars).\n` +
      `- content: the idea rewritten as clear, well-structured Markdown — keep the user's substance, organize it, expand only to clarify.\n` +
      `- research: a thorough deep-research brief to investigate this idea — the objective, 4-8 key questions to answer, what to look for, scope/constraints — and explicitly ask for the final answer as a structured Markdown research report. Do NOT include the literal text "/deep-research".`,
  },
  {
    key: 'bookmarks.summary',
    label: 'Bookmark summary',
    description: 'Summarizes a saved bookmark/link (~250 words). The title is added automatically.',
    default:
      `Write a clear, self-contained summary in about 250 words (do not exceed 280). ` +
      `Use plain prose — no markdown headings, no bullet lists. Capture what it is about, the key points / tools / steps, ` +
      `and who would find it useful, so it can be found later by meaning.`,
  },
  {
    key: 'skills.describe',
    label: 'Skill description',
    description: 'Writes the 1-2 sentence description of a Claude skill. The SKILL.md content is added automatically.',
    default:
      `In 1-2 plain sentences, describe what this Claude skill does and when it's useful. ` +
      `No preamble, no "This skill…", just the description.`,
  },
  {
    key: 'chat.answer',
    label: 'Chat — answer style',
    description: 'How "talk to my brain" chat answers. Your conversation + the retrieved memory excerpts are added automatically below this.',
    default:
      `You are the user's personal "second brain" assistant. You answer using (a) the conversation and (b) the MEMORY EXCERPTS provided — passages from the user's OWN saved bookmarks, notes, ideas, documents and activity that have ALREADY been retrieved for you.\n\n` +
      `Hard rules:\n` +
      `- The excerpts ARE available to you. NEVER say you can't access, browse, fetch or open anything. NEVER mention URLs, links, Caddy, servers, subdomains, proxies, or your own limitations.\n` +
      `- Answer the user's question DIRECTLY and helpfully in clean Markdown (short paragraphs, **bold**, bullet lists). Synthesize across excerpts; don't just quote fragments.\n` +
      `- Cite the excerpts you actually use inline as [1], [2].\n` +
      `- If the user pasted a link, the matching excerpt IS that page's saved content — answer from it.\n` +
      `- If the excerpts genuinely don't contain the answer, say briefly that you don't have anything saved about that, then stop — no tangents, no infrastructure talk.\n` +
      `- Never invent facts that aren't in the excerpts or conversation.`,
  },
  {
    key: 'chat.router',
    label: 'Chat — search router',
    description: 'Decides whether a chat message needs a fresh memory search or can be answered from the conversation. Must return JSON {"search":bool,"query":string}.',
    default:
      `You route a "chat with my memory" assistant. Decide if the NEW message needs a fresh search of the user's saved memory (a new topic or specific recall) ` +
      `or can be answered from the conversation already shown (a follow-up, clarification, "explain", or counter-question).\n` +
      `Respond with ONLY JSON: {"search": true|false, "query": "<a standalone search query if search is true, else empty>"}`,
  },
];

const MAP = new Map(REGISTRY.map((p) => [p.key, p]));

@Injectable()
export class PromptsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The active instruction for a key — the user's override if set, else the built-in default. */
  async get(key: PromptKey): Promise<string> {
    const def = MAP.get(key);
    const fallback = def?.default || '';
    const row = await this.prisma.setting.findUnique({ where: { key: `prompt.${key}` } });
    const v = row?.value?.trim();
    return v ? row!.value : fallback;
  }

  /** All prompts with their current (possibly overridden) value + default, for the Settings editor. */
  async list() {
    const rows = await this.prisma.setting.findMany({ where: { key: { startsWith: 'prompt.' } } });
    const overrides = new Map(rows.map((r) => [r.key.replace(/^prompt\./, ''), r.value]));
    return REGISTRY.map((p) => ({
      key: p.key,
      label: p.label,
      description: p.description,
      default: p.default,
      value: overrides.get(p.key) ?? p.default,
      customized: overrides.has(p.key) && overrides.get(p.key) !== p.default,
    }));
  }

  async set(key: string, value: string) {
    if (!MAP.has(key as PromptKey)) return null;
    const v = String(value || '').trim();
    if (!v) return this.reset(key);
    await this.prisma.setting.upsert({ where: { key: `prompt.${key}` }, create: { key: `prompt.${key}`, value: v }, update: { value: v } });
    return { key, value: v, customized: v !== MAP.get(key as PromptKey)!.default };
  }

  async reset(key: string) {
    if (!MAP.has(key as PromptKey)) return null;
    await this.prisma.setting.deleteMany({ where: { key: `prompt.${key}` } });
    return { key, value: MAP.get(key as PromptKey)!.default, customized: false };
  }
}
