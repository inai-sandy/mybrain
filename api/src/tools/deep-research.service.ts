import { Injectable, Logger } from '@nestjs/common';
import { WebResearchService, WebResult, WebSearchError, SearchWindow } from './web-research.service';
import { LlmService } from '../llm/llm.service';

/**
 * Our own deep research step (BEA-1196).
 *
 * Perplexity sells this as a product at roughly $1–2 a report, and their subscription does not cover
 * the API — their own CLI (`pplx`) is just a Search API front-end that still bills per request. So we
 * build the loop ourselves out of two things we already pay for: Tavily/Exa search (BEA-1194) and the
 * Codex engine on the owner's ChatGPT subscription, which costs nothing at the margin. A report ends
 * up costing only its search credits — cents, not dollars.
 *
 * Deep research is not mysterious: ask a lot of small questions, read the good pages, write it up
 * with citations. The flows already gestured at this by chaining one search into one "Ask AI". This
 * does it properly, with a real loop and a hard budget.
 *
 * THE LINE THAT MATTERS. BEA-1194 exists because letting the model decide *how* to search meant it
 * answered a 2025 question from 2021 training data. So here the model only decides WHAT to ask. Every
 * search is executed by us, and the write-up is handed nothing but what came back. It is told to say
 * "the sources do not cover this" rather than fill the gap, and the sources are appended so the claim
 * can be checked.
 */

export type ResearchBudget = { searches: number; extracts: number };
/** What a run actually consumed — recorded so the owner sees the real cost, not my estimate. */
export type ResearchSpend = {
  searches: number;
  extracts: number;
  sources: number;
  /** Of those searches, how many went to Exa. Only the Tavily ones are priced in Tavily credits. */
  meaningSearches: number;
  /** Of those searches, how many went to Brave — one call there does search AND page reading. */
  braveSearches: number;
  /**
   * Thinking steps that had to use a PAID model.
   *
   * The whole premise is that the writing is free because it runs on the subscription engine. But the
   * shared LLM layer falls back to Sonnet over OpenRouter whenever the host runner is down, slow or
   * empty — a real per-token charge. Silently, that would make "this report cost 12 credits" a lie.
   * So the fallback is allowed (throwing away research we already paid to gather would be the worse
   * trade) and counted.
   */
  paidCalls: number;
};
export type DeepResearchResult = { report: string; spend: ResearchSpend };

/**
 * A failure that still cost credits.
 *
 * Searches are spent before we know whether the run will produce anything, and a flow node can be set
 * to retry. If a failed attempt reported nothing, the run would show 0 spend having really paid for
 * three rounds of searching — the exact "trust my estimate" problem this feature was built to remove.
 * The spend rides on the error so the caller can record it either way.
 */
export class DeepResearchError extends WebSearchError {
  constructor(message: string, readonly spend: ResearchSpend) { super(message); }
}

/** Ceilings no setting may exceed. One step must never be able to run away with credits. */
const HARD_CAP: ResearchBudget = { searches: 8, extracts: 10 };
const DEFAULT_BUDGET: ResearchBudget = { searches: 6, extracts: 6 };

/** A Tavily advanced search is 2 credits. Only searches are priced here because that is the figure I verified. */
const CREDITS_PER_SEARCH = 2;

/** How much of each page the write-up is shown. Ten full extracts would swamp the prompt. */
const CHARS_PER_SOURCE = 3000;

/**
 * Only skip reading a page when its snippet already fills the space we would give the full text.
 *
 * This was 500 chars, which quietly disabled the whole reading step: Tavily's advanced search returns
 * snippets of up to 900, so every source looked "already covered" and a live run did 3 searches and 0
 * page reads. A snippet is a summary, not the page — reading the best few properly is the point of
 * DEEP research.
 */
const SNIPPET_IS_ENOUGH = CHARS_PER_SOURCE;

@Injectable()
export class DeepResearchService {
  private readonly log = new Logger('DeepResearch');

  constructor(
    private readonly web: WebResearchService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Turn the owner's two date fields into a window (BEA-1209).
   *
   * Returns undefined when neither is filled in — which is the normal case, so the guess still runs.
   * `stated: true` is what stops it being widened later.
   */
  static statedWindow(from?: string, to?: string): SearchWindow | undefined {
    const ok = (d?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '').trim()) ? String(d).trim() : '');
    const a = ok(from);
    const b = ok(to);
    if (!a && !b) return undefined;
    // One end alone is meaningful: "since January" or "up to March".
    const start = a || undefined;
    const end = b || undefined;
    if (start && end && start > end) return { start_date: end, end_date: start, stated: true }; // typed backwards
    return { start_date: start, end_date: end, stated: true };
  }

  /**
   * Pick the search back-end for one sub-question.
   *
   * Long, wordy questions with no proper noun, number or quoted phrase are exactly the ones keyword
   * search does badly — there are no keywords to match. Those go to Exa. Anything naming a thing, a
   * year or an exact phrase is a keyword search.
   */
  static prefersMeaning(q: string): boolean {
    const t = (q || '').trim();
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 9) return false;   // short = keyword-ish
    if (/\d/.test(t)) return false;       // a year or figure is a keyword
    if (/["'“”]/.test(t)) return false;   // a quoted phrase is a keyword
    return !words.slice(1).some((w) => /^[A-Z]/.test(w)); // no proper nouns → search by meaning
  }

  /**
   * Separate what THIS step is researching from the goal it sits inside (BEA-1199).
   *
   * A branch node prefixes the whole research goal above its own focus. The owner's report has a
   * ten-part, 1,254-character goal, so the planner was reading all ten demands in every branch and
   * writing sub-questions that wandered across the lot — the "messy research" he reported. (The same
   * prompt made Perplexity's own deep research return a 502.)
   *
   * The goal still matters, but only for reading ambiguous words the right way. It is context, not
   * the thing being researched.
   */
  static splitFocus(input: string): { focus: string; context: string } {
    const t = String(input || '');
    const MARK = 'THIS BRANCH FOCUSES ON:';
    // The LAST marker, not the first. A branch feeding another branch stacks the markers, and taking
    // the first would hand this step its parent's focus as well as its own — the very thing this
    // method exists to stop, just one level down.
    const at = t.lastIndexOf(MARK);
    if (at < 0) return { focus: t.trim(), context: '' };
    const focus = t.slice(at + MARK.length).trim();
    const before = t.slice(0, at);
    const goal = /OVERALL RESEARCH GOAL[^:]*:\s*([\s\S]*)$/.exec(before)?.[1] || '';
    return { focus, context: goal.trim().slice(0, 600) };
  }

  async run(
    question: string,
    opts: {
      budget?: Partial<ResearchBudget>;
      onLine?: (t: string) => void;
      /** Dates the OWNER typed (BEA-1209). Optional — without them the window is guessed as before. */
      from?: string;
      to?: string;
    } = {},
  ): Promise<DeepResearchResult> {
    const { focus, context } = DeepResearchService.splitFocus(question);
    const goal = focus;
    if (!goal) throw new WebSearchError('there is nothing to research — the step got no question.');

    const budget: ResearchBudget = {
      searches: this.cap(opts.budget?.searches, DEFAULT_BUDGET.searches, HARD_CAP.searches),
      extracts: this.cap(opts.budget?.extracts, DEFAULT_BUDGET.extracts, HARD_CAP.extracts),
    };
    const say = opts.onLine || (() => undefined);
    const spend: ResearchSpend = { searches: 0, extracts: 0, sources: 0, meaningSearches: 0, braveSearches: 0, paidCalls: 0 };

    // Work the date window and country out ONCE from the real question — a sub-question like
    // "AICTE approved intake" often loses the "2025 and 2026" the owner actually asked about.
    // A window the owner typed beats anything we could infer, and is never widened (BEA-1209).
    const stated = DeepResearchService.statedWindow(opts.from, opts.to);
    const window = stated ?? WebResearchService.dateWindow(goal);
    const country = WebResearchService.countryOf(goal);
    if (window.start_date) say(`   limiting to ${window.start_date} → ${window.end_date}${stated ? ' (your dates)' : ''}`);
    else if (window.time_range) say(`   limiting to the last ${window.time_range}`);
    if (country) say(`   focused on ${country}`);

    const have = await this.web.available().catch(() => ({ tavily: false, exa: false, brave: false }) as any);
    if (!have.tavily && !have.exa && !have.brave) {
      throw new WebSearchError('no search is connected — add a Brave, Tavily or Exa key in Settings → Integrations.');
    }

    // 1. Plan. The model chooses the questions; it never chooses how they get answered.
    const { asks, sites } = await this.plan(goal, context, budget.searches, say, spend);
    say(`   researching ${asks.length} question${asks.length === 1 ? '' : 's'}, up to ${budget.searches} searches`);

    // 2. Gather. One search per sub-question, deduplicated by URL across all of them.
    const seen = new Set<string>();
    let useBraveFirst = false;
    const alreadyRead = new Set<string>(); // Brave hands back the page content with the search
    const found: WebResult[] = [];
    const failures: string[] = [];
    for (const ask of asks) {
      if (spend.searches >= budget.searches) break;
      const meaning = DeepResearchService.prefersMeaning(ask) && have.exa;
      // Which gatherer? (BEA-1205)
      //  • Exa when the question has no keywords to match.
      //  • Tavily when we need PRECISION — a real date window or a list of sites to stay inside.
      //    Brave only has `site:` and a coarse freshness setting.
      //  • Brave otherwise: one call does search AND extraction, and returns ranked chunks. Measured
      //    at 3 calls / 11,111 words / 3.7s against Tavily's 15 / 69,702 / 23.7s for the same three
      //    questions — and it found more sources.
      const needsPrecision = !!(window.start_date || window.time_range || sites.length);
      const useBrave = !meaning && have.brave && !needsPrecision;
      say(`   🔎 ${ask.slice(0, 80)}`);
      if (meaning || useBrave) spend.searches++;
      if (meaning) spend.meaningSearches++;
      if (useBrave) { spend.braveSearches++; useBraveFirst = true; }
      try {
        const rows = meaning
          ? await this.web.searchByMeaning(ask)
          : useBrave
            ? await this.web.braveContext(ask, { country, window })
            : await this.web.search(ask, 6, { includeDomains: sites, window, country, onAttempt: () => { spend.searches++; } });
        // Brave already returned the page's content. Paying Tavily to open it again buys nothing.
        if (useBrave) for (const r of rows) alreadyRead.add(r.url);
        let fresh = 0;
        for (const r of rows) {
          const key = this.urlKey(r.url);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          found.push(r);
          fresh++;
        }
        say(`      ${fresh} new source${fresh === 1 ? '' : 's'}`);
      } catch (e: any) {
        // One sub-question failing must not lose the whole report — but every failure is remembered,
        // so if NOTHING worked we can say exactly why instead of shrugging.
        const why = String(e?.message || e);
        failures.push(`“${ask.slice(0, 60)}” — ${why}`);
        say(`      failed: ${why.slice(0, 90)}`);
      }
    }
    spend.sources = found.length;

    // Before concluding that nothing exists, ASK THE OTHER INDEX (BEA-1205).
    //
    // Measured: Brave and Tavily shared only 3/6, 2/6 and 0/6 hosts on three real questions — on one
    // they returned completely different sources. So one index drawing a blank is weak evidence.
    // "This data does not exist publicly" is the most consequential sentence this tool writes, and
    // the owner's placement report turned on exactly that claim. It costs one extra call, only in
    // the case where being wrong matters most.
    if (!found.length && have.brave && have.tavily) {
      say('   🔁 nothing found — asking the other index before saying so');
      const second = await (useBraveFirst ? this.web.search(goal, 6, { country }) : this.web.braveContext(goal, { country }))
        .catch(() => [] as WebResult[]);
      spend.searches++;
      if (!useBraveFirst) spend.braveSearches++;
      for (const r of second) {
        const key = this.urlKey(r.url);
        if (key && !seen.has(key)) { seen.add(key); found.push(r); }
      }
      spend.sources = found.length;
      if (found.length) say(`      the second index found ${found.length}`);
    }

    if (!found.length) {
      const why = failures.length ? ` Reasons: ${failures.join('; ')}` : '';
      // With dates the owner set, "nothing found" means nothing IN THAT PERIOD — a completely
      // different statement from "this does not exist". Saying the wrong one is how a report comes
      // to conclude the data is unavailable when we simply looked in the wrong years (BEA-1209).
      const scope = stated
        ? ` Nothing was published between ${stated.start_date || 'the start'} and ${stated.end_date || 'today'} — that is the dates you set, not a sign the information does not exist.`
        : '';
      throw new DeepResearchError(`the searches found nothing to work from, so there is no report to write.${scope}${why}`, spend);
    }

    // 3. Read the best pages properly. A long snippet already says enough.
    // Brave already returned the page content, so re-reading those costs a credit for nothing.
    const toRead = found.filter((r) => (r.snippet || '').length < SNIPPET_IS_ENOUGH && !alreadyRead.has(r.url)).slice(0, budget.extracts);
    const pages = new Map<string, string>();
    for (const r of toRead) {
      if (spend.extracts >= budget.extracts) break;
      spend.extracts++;
      try {
        const text = await this.web.readPage(r.url);
        pages.set(r.url, text);
        say(`   📄 read ${this.host(r.url)}`);
      } catch (e: any) {
        // A page that won't open is normal — we still have its snippet.
        say(`   📄 could not read ${this.host(r.url)}`);
      }
    }

    // 4. Write it up, from the sources only.
    const sources = this.numbered(found, pages);
    const report = await this.write(goal, sources, say, spend, found.length, stated);
    const list = this.sourceList(found);
    const cost = this.costLine(spend);
    say(`   💸 used ${cost}`);

    // 5. The source list always ships, so the links reach the saved document even if a later step
    //    throws them away (BEA-1193).
    return { report: `${report}\n\n---\n\n### Sources\n\n${list}\n\n_Researched with ${cost}._`, spend };
  }

  // ---- the steps ------------------------------------------------------------------------------

  /** Break the goal into searchable sub-questions. The model plans; it does not answer. */
  private async plan(goal: string, context: string, max: number, say: (t: string) => void, spend: ResearchSpend): Promise<{ asks: string[]; sites: string[] }> {
    const prompt = [
      'You are PLANNING research. Do not answer anything.',
      '',
      'RESEARCH THIS — and only this:',
      goal.slice(0, 1500),
      '',
      ...(context ? ['It sits inside a wider piece of work, given ONLY so you read ambiguous words correctly.', 'Do NOT research the wider work:', context, ''] : []),
      `Write between 3 and ${max} short search questions that together cover this goal.`,
      'Rules:',
      '- One per line. No numbering, no bullets, no commentary, no headings.',
      '- If, and ONLY if, you are certain which websites publish this, add a final line of the form',
      '  "sites: example.gov, example.org" (domains only, at most 5). If you are not sure, leave it out.',
      '- Each line must be something you could type into a search box.',
      '- Cover different parts of the goal; do not rephrase the same question twice.',
      '- Do not answer any of them.',
    ].join('\n');

    const { text, paid } = await this.engine(prompt, 700, 'deep-research-plan');
    if (paid) spend.paidCalls++;
    const asks = this.parsePlan(text, max);
    const sites = this.parseSites(text);
    if (sites.length) say(`   looking first at ${sites.join(', ')}`);
    if (asks.length) return { asks, sites };
    // Planning failing is not fatal: searching the goal verbatim is still a real search of the real
    // web. What must never happen is answering from memory, and that is a different step.
    say('   could not plan sub-questions — searching the question directly');
    this.log.warn('deep research: planning produced nothing, falling back to the raw question');
    return { asks: [goal.slice(0, 300)], sites: [] };
  }

  /**
   * Websites the planner is confident about, if it named any (BEA-1199).
   *
   * Only ever a hint. `WebResearchService.search` retries without the filter when it finds nothing,
   * because a wrong guess returns zero results and zero results reads as "this does not exist" —
   * the most expensive wrong answer this tool can give.
   */
  parseSites(text: string | null | undefined): string[] {
    const line = /^\s*sites?\s*:\s*(.+)$/im.exec(String(text || ''))?.[1] || '';
    const out: string[] = [];
    for (const raw of line.split(/[,;\s]+/)) {
      const d = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !out.includes(d)) out.push(d);
      if (out.length >= 5) break;
    }
    return out;
  }

  /** Turn the planner's reply into clean, bounded, de-duplicated questions. */
  parsePlan(text: string | null | undefined, max: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of String(text || '').split('\n')) {
      const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["'“]|["'”]$/g, '').trim();
      if (line.length < 8 || line.length > 200) continue;
      // Drop the model's chatter around the list — a heading ("Here are the questions:") or an
      // opener. Deliberately narrow: an earlier version dropped anything starting with "question",
      // which threw away real sub-questions like "question of who actually pays for it".
      if (line.endsWith(':')) continue;
      if (/^sites?\s*:/i.test(line)) continue; // the domain hint, not a question
      if (/^(here (are|is)|these are|sure|okay|below|i(?:'| a)m going to)\b/i.test(line)) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= max) break;
    }
    return out;
  }

  /** The write-up. Sources only — and it must admit a gap rather than fill it. */
  private async write(goal: string, sources: string, say: (t: string) => void, spend: ResearchSpend, sourceCount: number, stated?: SearchWindow): Promise<string> {
    say('   ✍️ writing the report');
    const prompt = [
      'Write a clear, well-structured report answering the question below, using ONLY the sources given.',
      '',
      'QUESTION:',
      goal.slice(0, 1500),
      '',
      ...(stated ? [`The owner limited this to ${stated.start_date || 'any time'} → ${stated.end_date || 'today'}. Say so in the report, and if something is missing, say it was not found IN THAT PERIOD rather than that it does not exist.`, ''] : []),
      'START WITH A SHORT SECTION headed "## What I could and could not answer".',
      'Two plain lists under it: what the sources DO answer, and what they do NOT.',
      `You were given ${sourceCount} source(s). Be specific — name the part of the question each gap belongs to.`,
      'Then write the report itself.',
      '',
      'RULES',
      '- Use only what the sources say. For this task you have no other knowledge.',
      '- Cite with [n], matching the source numbers below.',
      '- Where the sources do not cover part of the goal, say so plainly — for example "the sources do not cover X". Never fill a gap from memory.',
      '- Plain English. Short sentences. No preamble, no padding, no restating the goal.',
      '',
      'SOURCES',
      sources,
    ].join('\n');

    const { text, paid } = await this.engine(prompt, 6000, 'deep-research-write');
    if (paid) {
      spend.paidCalls++;
      say('   ⚠️ your own engine was unavailable — the write-up used the paid model instead');
    }
    if (text && text.trim()) return text.trim();

    // The write-up failing must not destroy the research — 12,400 characters were lost that way once
    // (BEA-1193). Hand back what we gathered, and say plainly that it is unwritten.
    this.log.warn('deep research: the write-up step produced nothing; returning the gathered sources');
    return `⚠️ **The write-up step failed**, so this is the raw research rather than a finished report. The sources found are below — nothing here has been summarised or checked.`;
  }

  // ---- helpers --------------------------------------------------------------------------------

  /**
   * Run a thinking step and say whether it had to be PAID for.
   *
   * `deep-research` defaults to Codex, which is free on the subscription — that is the entire reason
   * this feature exists instead of paying Perplexity. But the shared LLM layer quietly falls back to
   * Sonnet over OpenRouter when the host runner is down, slow or empty. That fallback is worth having
   * (losing research we already paid to gather is worse), but it must never be invisible, or the cost
   * we report is a lie. So compare the model that actually answered against the one we asked for.
   */
  private async engine(prompt: string, maxTokens: number, label: string): Promise<{ text: string | null; paid: boolean }> {
    const cfg: any = (await this.llm.helperModel?.('deep-research').catch(() => null)) ?? null;
    // Older/partial harnesses may not expose completeWithModel — fall back to the plain helper call,
    // which cannot report the model, so we do not claim to know whether it was paid.
    if (!this.llm.completeWithModel) {
      const text = await this.llm.completeHelper?.('deep-research', prompt, maxTokens, label).catch(() => null);
      return { text: text ?? null, paid: false };
    }
    const r = await this.llm.completeWithModel(cfg, prompt, maxTokens, label).catch(() => null);
    const text = r?.text ?? null;
    if (!text) return { text: null, paid: false };
    const flatRate = cfg?.provider === 'codex' || cfg?.provider === 'gemini';
    // No flat-rate engine configured → every call is a paid one. Configured but a different model
    // answered → the fallback kicked in.
    return { text, paid: !flatRate || r?.model !== cfg?.model };
  }

  /** The cost, in the only units that are actually verified. */
  private costLine(spend: ResearchSpend): string {
    const tavily = Math.max(0, spend.searches - spend.meaningSearches - spend.braveSearches);
    const bits = [`${spend.searches} search${spend.searches === 1 ? '' : 'es'}`, `${spend.extracts} page read${spend.extracts === 1 ? '' : 's'}`];
    // Only Tavily's rate is a figure I checked, so only Tavily searches are priced.
    const priced = tavily > 0 ? `${tavily * CREDITS_PER_SEARCH} Tavily credits` : '';
    const exa = spend.meaningSearches > 0 ? `${spend.meaningSearches} of them on Exa` : '';
    const brave = spend.braveSearches > 0 ? `${spend.braveSearches} on Brave (search + read in one)` : '';
    const paid = spend.paidCalls > 0 ? `⚠️ ${spend.paidCalls} thinking step${spend.paidCalls === 1 ? '' : 's'} used the paid model because your own engine was unavailable` : '';
    const notes = [priced, exa, brave, paid].filter(Boolean).join(' · ');
    return `${bits.join(' + ')}${notes ? ` (${notes})` : ''}`;
  }

  private cap(want: number | undefined, dflt: number, max: number): number {
    const n = Number.isFinite(want) ? Math.floor(Number(want)) : dflt;
    return Math.max(1, Math.min(n, max));
  }

  /** Sources as the write-up sees them: full page text where we have it, snippet where we don't. */
  private numbered(found: WebResult[], pages: Map<string, string>): string {
    return found
      .map((r, i) => {
        const body = (pages.get(r.url) || r.snippet || '').slice(0, CHARS_PER_SOURCE);
        const when = this.day(r.published) ? ` · ${this.day(r.published)}` : '';
        return `[${i + 1}] ${r.title}${when}\n${r.url}\n${body}`;
      })
      .join('\n\n');
  }

  private sourceList(found: WebResult[]): string {
    return found.map((r, i) => `${i + 1}. [${r.title}](${r.url})${this.day(r.published) ? ` — ${this.day(r.published)}` : ''}`).join('\n');
  }

  /**
   * A publication date a person can read.
   *
   * Tavily returns RFC-822 ("Sat, 02 Aug 2026 00:00:00 GMT"), so the obvious slice(0,10) produced
   * "Sat, 02 Au" in a live report. Parse it properly and fall back to showing nothing.
   */
  private day(v: unknown): string {
    const raw = String(v ?? '').trim();
    if (!raw) return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const t = Date.parse(raw);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
  }

  /** Same page reached two ways is one source. */
  private urlKey(url: string): string {
    const u = String(url || '').trim();
    if (!u) return '';
    return u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[/?#].*$/, '') + this.path(u);
  }

  private path(u: string): string {
    const m = /^https?:\/\/[^/]+(\/[^?#]*)/i.exec(u);
    return (m?.[1] || '').replace(/\/$/, '');
  }

  private host(url: string): string {
    return String(url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0] || 'the page';
  }
}
