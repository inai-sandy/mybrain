import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The user-editable instruction templates. Dynamic data (the dump, evidence, title…) is appended in code, NOT here. */
export type PromptKey = 'tasks.dump' | 'daily.summary' | 'daily.personality' | 'ideas.organize' | 'bookmarks.summary' | 'skills.describe';

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
