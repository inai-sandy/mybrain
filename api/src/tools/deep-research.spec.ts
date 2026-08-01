import { DeepResearchService } from './deep-research.service';
import { WebSearchError } from './web-research.service';

/**
 * BEA-1196 — our own deep research loop, built because Perplexity wanted ~$1–2 a report and their
 * subscription does not cover the API.
 *
 * These pin the two promises that make it safe to use: it can never run away with search credits,
 * and it can never quietly answer from the model's own memory when the searching failed — which is
 * the exact bug BEA-1194 was raised for.
 */
function make(opts: {
  results?: Record<string, any[]>;
  plan?: string | null;
  report?: string | null;
  available?: { tavily: boolean; exa: boolean; brave?: boolean };
  onSearch?: (q: string, kind: 'keyword' | 'meaning') => void;
  readFails?: boolean;
  engineDown?: boolean;
  attemptsPerSearch?: number;
  helperCfg?: any;
} = {}) {
  const calls = { searches: 0, extracts: 0, meaning: 0, brave: 0 };
  const web: any = {
    available: async () => opts.available ?? { tavily: true, exa: true, brave: false },
    search: async (q: string, _max?: number, o?: any) => {
      calls.searches++; opts.onSearch?.(q, 'keyword');
      // The real service reports every Tavily request it makes, so the double must too — otherwise
      // these tests would pass while spend silently read zero.
      for (let i = 0; i < (opts.attemptsPerSearch ?? 1); i++) o?.onAttempt?.();
      return opts.results?.[q] ?? opts.results?.['*'] ?? [{ title: 'A page', url: `https://x.test/${calls.searches}`, snippet: 'short' }];
    },
    searchByMeaning: async (q: string) => {
      // `calls.searches` means TAVILY calls only. It used to count Exa too, which was harmless when
      // a question went to exactly one index — and became confusing the moment every question swept
      // all three (BEA-1239).
      calls.meaning++; opts.onSearch?.(q, 'meaning');
      return opts.results?.[q] ?? opts.results?.['*'] ?? [{ title: 'A page', url: `https://m.test/${calls.meaning}`, snippet: 'short' }];
    },
    braveContext: async (q: string) => {
      calls.brave++; opts.onSearch?.(q, 'keyword');
      return opts.results?.[q] ?? opts.results?.['*'] ?? [{ title: 'Brave page', url: `https://b.test/${calls.brave}`, snippet: 'short' }];
    },
    readPage: async (u: string) => {
      calls.extracts++;
      if (opts.readFails) throw new WebSearchError('that page returned nothing readable');
      return `### ${u}\n\nfull text of the page`;
    },
  };
  const cfg = opts.helperCfg === undefined ? { provider: 'codex', model: 'codex' } : opts.helperCfg;
  const answer = (label: string) =>
    label === 'deep-research-plan' ? (opts.plan === undefined ? 'first question here\nsecond question here\nthird question here' : opts.plan)
      : (opts.report === undefined ? 'The report body [1].' : opts.report);
  const llm: any = {
    helperModel: jest.fn(async () => cfg),
    completeWithModel: jest.fn(async (_c: any, _p: string, _t: number, label: string) => ({
      text: answer(label),
      // A fallback is what the shared layer really does when the host runner is unavailable.
      model: opts.engineDown ? 'Claude Sonnet 4.6 (fallback)' : cfg?.model,
      flatRate: opts.engineDown ? false : !!cfg,
    })),
    completeHelper: jest.fn(async (_k: string, _p: string, _t: number, label: string) => answer(label)),
  };
  return { svc: new DeepResearchService(web, llm), calls, llm };
}

describe('deep research (BEA-1196)', () => {
  it('plans, searches, reads and writes — with the sources appended', async () => {
    const { svc, calls } = make();
    const { report, spend } = await svc.run('what is changing in fresher hiring');
    // 3 questions × 2 configured indexes (Tavily + Exa) = 6 calls, 6 distinct pages (BEA-1239).
    expect(calls.searches).toBe(3);   // Tavily, once per question
    expect(calls.meaning).toBe(3);    // Exa, once per question
    expect(report).toContain('The report body [1].');
    expect(report).toContain('### Sources');
    expect(report).toContain('https://x.test/1');       // the links must reach the saved document
    expect(spend).toMatchObject({ searches: 6, tavilySearches: 3, meaningSearches: 3 });
    expect(spend.sources).toBe(6);
  });

  // The whole reason the owner rejected Perplexity was cost. A step that can quietly do 40 searches
  // rebuilds that problem in our own code.
  it('never exceeds its search budget, however many questions the model proposes', async () => {
    const plan = Array.from({ length: 30 }, (_, i) => `question number ${i} about the topic`).join('\n');
    const { svc, calls } = make({ plan });
    const { spend } = await svc.run('a big question', { budget: { searches: 2, extracts: 1 } });
    // The budget counts CALLS, not questions — one question now costs one call per index, so a
    // budget of 2 buys a single question's sweep and then stops. That is the safety net working.
    expect(spend.searches).toBeLessThanOrEqual(2);
    expect(calls.extracts).toBe(1);
    expect(spend).toMatchObject({ extracts: 1 });
  });

  it('clamps a silly budget to the hard cap instead of trusting it', async () => {
    const plan = Array.from({ length: 40 }, (_, i) => `question number ${i} about the topic`).join('\n');
    const { svc, calls } = make({ plan });
    await svc.run('a big question', { budget: { searches: 999, extracts: 999 } });
    // The ceiling rose 8 → 24 with BEA-1239 because every question now sweeps three indexes on
    // purpose. It is still a hard ceiling: 40 proposed questions cannot spend more than this.
    expect(calls.searches + calls.meaning + calls.brave).toBeLessThanOrEqual(24);
    expect(calls.extracts).toBeLessThanOrEqual(10);
  });

  // A retried node would otherwise search three times over and report zero spend.
  it('still reports what it spent when it fails', async () => {
    const { svc } = make({ results: { '*': [] } });
    const err: any = await svc.run('nothing findable').catch((e: any) => e);
    // 3 questions × 2 indexes, then the last-resort sweep asks the goal itself on both (BEA-1239).
    expect(err.spend).toMatchObject({ searches: 8, sources: 0 });
  });

  it('fails loudly when the searches found nothing — it must NOT write from memory', async () => {
    const { svc, llm } = make({ results: { '*': [] } });
    await expect(svc.run('something nobody has written about')).rejects.toThrow(/found nothing to work from/);
    // the write-up must never have been attempted
    expect(llm.completeWithModel.mock.calls.some((c: any[]) => c[3] === 'deep-research-write')).toBe(false);
  });

  it('says why when every search failed, rather than shrugging', async () => {
    const web: any = {
      available: async () => ({ tavily: true, exa: false }),
      search: async () => { throw new WebSearchError('Tavily is out of credits or rate-limited right now.'); },
      searchByMeaning: async () => [],
      readPage: async () => '',
    };
    const svc = new DeepResearchService(web, { helperModel: async () => null, completeWithModel: async () => ({ text: 'one question about the thing', model: 'x' }) } as any);
    await expect(svc.run('anything at all')).rejects.toThrow(/out of credits or rate-limited/);
  });

  it('keeps the research when the write-up fails, instead of throwing it away', async () => {
    // BEA-1193: 12,400 characters of real research were lost to a failing final step once.
    const { svc } = make({ report: null });
    const { report } = await svc.run('a question worth researching');
    expect(report).toMatch(/write-up step failed/i);
    expect(report).toContain('### Sources');
    expect(report).toContain('https://x.test/1');
  });

  it('still searches the goal itself when planning comes back empty', async () => {
    const seen: string[] = [];
    const { svc, calls } = make({ plan: null, onSearch: (q) => seen.push(q) });
    await svc.run('the original goal text');
    expect(calls.searches).toBe(1);
    expect(seen[0]).toBe('the original goal text');
  });

  it('refuses to start when no search back-end is connected', async () => {
    const { svc } = make({ available: { tavily: false, exa: false } });
    await expect(svc.run('anything')).rejects.toThrow(/no search is connected/);
  });

  it('refuses an empty question', async () => {
    const { svc } = make();
    await expect(svc.run('   ')).rejects.toBeInstanceOf(WebSearchError);
  });

  it('counts the same page found twice as one source', async () => {
    const dup = [{ title: 'Same', url: 'https://dup.test/a/', snippet: 'short' }];
    const { svc } = make({ results: { '*': dup } });
    const { spend } = await svc.run('a question about something');
    expect(spend.sources).toBe(1);       // every index found the same page — counted once
    expect(spend.searches).toBe(6);      // 3 questions × 2 configured indexes
  });

  // Caught by running it live: the threshold was 500, but Tavily snippets run to 900, so a real run
  // did 3 searches and ZERO page reads — the whole "read the best pages" step was dead.
  it('still reads the page when the snippet is only a search-result summary', async () => {
    const snippet = 'x'.repeat(900); // the longest Tavily gives us
    const { svc, calls } = make({ results: { '*': [{ title: 'Summary only', url: 'https://long.test/a', snippet }] } });
    await svc.run('a question about something');
    expect(calls.extracts).toBe(1);
  });

  it('does not spend an extract when the snippet already fills the space the full text would get', async () => {
    const whole = 'x'.repeat(3200); // >= CHARS_PER_SOURCE, so reading adds nothing
    const { svc, calls } = make({ results: { '*': [{ title: 'Full', url: 'https://long.test/a', snippet: whole }] } });
    await svc.run('a question about something');
    expect(calls.extracts).toBe(0);
  });

  it('carries on when a page will not open — the snippet is still a source', async () => {
    const { svc } = make({ readFails: true });
    const { report, spend } = await svc.run('a question about something');
    expect(spend.sources).toBe(6);
    expect(report).toContain('### Sources');
  });

  // A live report listed sources as "Sat, 02 Au" — Tavily dates are RFC-822 and a 10-char slice cuts
  // them mid-month.
  it('shows readable dates, whatever format the search API used', async () => {
    const rows = [
      { title: 'RFC date', url: 'https://a.test/1', snippet: 's', published: 'Sat, 02 Aug 2026 00:00:00 GMT' },
      { title: 'ISO date', url: 'https://a.test/2', snippet: 's', published: '2026-03-14T09:00:00Z' },
      { title: 'Junk date', url: 'https://a.test/3', snippet: 's', published: 'sometime last year' },
    ];
    const { svc } = make({ results: { '*': rows }, plan: 'one question about the thing' });
    const { report } = await svc.run('a question');
    expect(report).toContain('2026-08-02');
    expect(report).toContain('2026-03-14');
    expect(report).not.toMatch(/Sat, 02 Au\b/);
    expect(report).not.toContain('sometime la');   // unparseable → show nothing, not a truncation
  });

  it('reports what it spent, in the output as well as the return value', async () => {
    const { svc } = make();
    const { report } = await svc.run('a question about something');
    expect(report).toMatch(/6 searches \+ 6 page reads \(6 Tavily credits/);
  });

  /**
   * The premise of this whole feature is that the writing is free because it runs on the
   * subscription engine. The shared LLM layer silently falls back to Sonnet over OpenRouter when the
   * host runner is down — so "this report cost 12 credits" would be a lie exactly when it mattered.
   */
  describe('when your own engine is unavailable', () => {
    it('counts the paid calls instead of hiding them', async () => {
      const { svc } = make({ engineDown: true });
      const { spend } = await svc.run('a question about something');
      expect(spend.paidCalls).toBe(2); // the plan and the write-up
    });

    it('says so in the run and in the report', async () => {
      const lines: string[] = [];
      const { svc } = make({ engineDown: true });
      const { report } = await svc.run('a question about something', { onLine: (t) => lines.push(t) });
      expect(lines.join('\n')).toMatch(/every free engine was unavailable/);
      expect(report).toMatch(/on a paid model/);
    });

    it('reports nothing paid on the normal path', async () => {
      const { svc } = make();
      const { report, spend } = await svc.run('a question about something');
      expect(spend.paidCalls).toBe(0);
      expect(report).not.toMatch(/paid model/);
    });

    // The planner runs on a small paid model BY CHOICE (BEA-1206). Warning that the engine is down
    // when nothing went wrong is the same false alarm this project keeps removing.
    it('does not cry "engine down" when a paid model was the deliberate choice', async () => {
      const lines: string[] = [];
      const web: any = { available: async () => ({ tavily: true, exa: false, brave: false }), search: async () => [{ title: 'T', url: 'https://a', snippet: 's' }], readPage: async () => 't' };
      const llm: any = {
        helperModel: async () => ({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }), // chosen, not a fallback
        completeWithModel: async (_c: any, _p: string, _t: number, l: string) => ({ text: l === 'deep-research-plan' ? 'one question here' : 'report', model: 'haiku', provider: 'openrouter', flatRate: false }),
      };
      await new DeepResearchService(web, llm).run('a question', { onLine: (t) => lines.push(t) });
      expect(lines.join('\n')).not.toMatch(/unavailable/);
    });

    it('treats "no flat-rate engine configured" as paid, because it is', async () => {
      const { svc } = make({ helperCfg: null });
      const { spend } = await svc.run('a question about something');
      expect(spend.paidCalls).toBe(2);
    });
  });

  it('prices only the Tavily searches — Exa is not billed at Tavily rates', async () => {
    // One vague sub-question routes to Exa; the other two are keyword searches.
    const plan = 'what makes some people quietly give up on their own ideas\nCOEP placements 2026\nIndia hiring report';
    const { svc } = make({ plan });
    const { report, spend } = await svc.run('a question');
    // Every question goes to both now, so Exa is asked 3 times and Tavily 3 times — but only the
    // Tavily calls carry a credit price.
    expect(spend).toMatchObject({ tavilySearches: 3, meaningSearches: 3 });
    expect(report).toMatch(/6 Tavily credits/);
    expect(report).toMatch(/3 of them on Exa/);
  });

  it('tells the run what it is doing at every stage', async () => {
    const lines: string[] = [];
    const { svc } = make();
    await svc.run('a question about something', { onLine: (t) => lines.push(t) });
    const all = lines.join('\n');
    expect(all).toMatch(/researching 3 questions/);
    expect(all).toMatch(/🔎 first question here/);
    expect(all).toMatch(/📄 read /);
    expect(all).toMatch(/✍️ writing the report/);
    expect(all).toMatch(/💸 used/);
  });

  describe('choosing the search back-end', () => {
    it('sends wordy, nameless questions to meaning search', () => {
      expect(DeepResearchService.prefersMeaning('what makes some people give up on their own ideas early')).toBe(true);
    });
    it('keeps anything with a name, a year or a quoted phrase on keyword search', () => {
      expect(DeepResearchService.prefersMeaning('what changed for fresh graduates in India this year')).toBe(false); // proper noun
      expect(DeepResearchService.prefersMeaning('what is happening to entry level roles in 2026 across the board')).toBe(false); // year
      expect(DeepResearchService.prefersMeaning('why do people say "quiet firing" about this whole thing')).toBe(false); // quoted
      expect(DeepResearchService.prefersMeaning('fresher hiring trends')).toBe(false); // short
    });
    it('never reaches for Exa when Exa has no key', async () => {
      const { svc, calls } = make({
        available: { tavily: true, exa: false },
        plan: 'what makes some people give up on their own ideas early',
      });
      await svc.run('a question');
      expect(calls.meaning).toBe(0);
      expect(calls.searches).toBe(1);
    });
    it('uses Exa for that same question when Exa IS connected', async () => {
      const { svc, calls } = make({ plan: 'what makes some people give up on their own ideas early' });
      await svc.run('a question');
      expect(calls.meaning).toBe(1);
    });
  });

  describe('reading the planner', () => {
    it('strips numbering, bullets and quotes', () => {
      const svc = make().svc;
      expect(svc.parsePlan('1. first thing here\n- second thing here\n* "third thing here"', 8))
        .toEqual(['first thing here', 'second thing here', 'third thing here']);
    });
    it('drops preamble, blanks, one-word lines and duplicates', () => {
      const svc = make().svc;
      expect(svc.parsePlan('Here are the questions:\n\nfirst thing here\nok\nFIRST THING HERE\n', 8))
        .toEqual(['first thing here']);
    });
    // Caught in review of this issue: the first filter dropped every line starting with "question",
    // so a plan of "question 1 …/question 2 …" silently became no research at all.
    it('keeps real questions that happen to start with the word "question"', () => {
      const svc = make().svc;
      expect(svc.parsePlan('question of who actually pays for it\nquestion 2 about the timing', 8))
        .toEqual(['question of who actually pays for it', 'question 2 about the timing']);
    });
    it('never returns more than it was asked for', () => {
      const svc = make().svc;
      const many = Array.from({ length: 20 }, (_, i) => `question number ${i} here`).join('\n');
      expect(svc.parsePlan(many, 3)).toHaveLength(3);
    });
  });

  /**
   * BEA-1199 — the owner's report has a ten-part, 1,254-character goal, and every branch was handed
   * all ten demands. The planner then wrote sub-questions that wandered across the lot. (The same
   * prompt made Perplexity's own deep research return a 502.)
   */
  describe('a branch researches its own focus, not the whole goal', () => {
    const branchInput = [
      'OVERALL RESEARCH GOAL (interpret every term and stay strictly within this):',
      '1. Study Engineering and MBA students. 2. Find pass-out numbers. 3. Find placement data.',
      '4. Cover campus and off-campus. 5. Break into job categories. 6. Estimate percentages.',
      '',
      'THIS BRANCH FOCUSES ON:',
      'Find data on Engineering and MBA student graduation numbers for 2025 and 2026.',
    ].join('\n');

    it('splits the focus from the surrounding goal', () => {
      const { focus, context } = DeepResearchService.splitFocus(branchInput);
      expect(focus).toBe('Find data on Engineering and MBA student graduation numbers for 2025 and 2026.');
      expect(context).toContain('Study Engineering and MBA students');
      expect(focus).not.toContain('Break into job categories');
    });

    it('treats a plain question with no branch marker as the focus itself', () => {
      expect(DeepResearchService.splitFocus('just this question').focus).toBe('just this question');
      expect(DeepResearchService.splitFocus('just this question').context).toBe('');
    });

    it('plans against the focus and only mentions the goal as context', async () => {
      const { svc, llm } = make();
      await svc.run(branchInput);
      const planPrompt = llm.completeWithModel.mock.calls.find((c: any[]) => c[3] === 'deep-research-plan')[1];
      expect(planPrompt).toContain('RESEARCH THIS — and only this:');
      expect(planPrompt).toContain('graduation numbers for 2025 and 2026');
      expect(planPrompt).toContain('Do NOT research the wider work');
    });
  });

  describe('the report says what it could not answer (BEA-1199)', () => {
    it('asks for that section up front, with the real source count', async () => {
      const { svc, llm } = make();
      await svc.run('a question about something');
      const writePrompt = llm.completeWithModel.mock.calls.find((c: any[]) => c[3] === 'deep-research-write')[1];
      expect(writePrompt).toContain('What I could and could not answer');
      expect(writePrompt).toContain('You were given 6 source(s)');
    });
  });

  describe('site hints from the planner (BEA-1199)', () => {
    it('reads a sites: line and passes it to the search', async () => {
      const seen: any[] = [];
      const web: any = {
        available: async () => ({ tavily: true, exa: false }),
        search: async (_q: string, _m: number, o: any) => { seen.push(o); return [{ title: 'T', url: 'https://a', snippet: 's' }]; },
        searchByMeaning: async () => [],
        readPage: async () => 'text',
      };
      const llm: any = {
        helperModel: async () => ({ provider: 'codex', model: 'codex' }),
        completeWithModel: async (_c: any, _p: string, _t: number, label: string) => ({
          text: label === 'deep-research-plan' ? 'how many students graduated\nsites: aicte-india.org, https://www.aishe.gov.in/reports' : 'report', model: 'codex',
        }),
      };
      const svc = new DeepResearchService(web, llm);
      await svc.run('engineering graduates in India 2026');
      expect(seen[0].includeDomains).toEqual(['aicte-india.org', 'aishe.gov.in']);
      expect(seen[0].country).toBe('india');
      expect(seen[0].window.start_date).toBe('2026-01-01');
    });

    it('never mistakes the sites line for a question to research', () => {
      const svc = make().svc;
      expect(svc.parsePlan('how many students graduated\nsites: a.org, b.org', 8)).toEqual(['how many students graduated']);
    });

    it('ignores rubbish in the sites line and caps it at five', () => {
      const svc = make().svc;
      expect(svc.parseSites('sites: not a domain, good.org, x.gov.in, a.com, b.com, c.com, d.com, e.com')).toEqual(['good.org', 'x.gov.in', 'a.com', 'b.com', 'c.com']);
      expect(svc.parseSites('no sites line here')).toEqual([]);
    });
  });

  /**
   * Review findings on BEA-1199, each fixed before shipping. These are the regression net.
   */
  describe('review fixes (BEA-1199)', () => {
    // HIGH: one question can cost up to three Tavily calls once the widening fallbacks fire. Counting
    // questions instead of calls under-reported the bill by up to 3x, exactly when it mattered.
    it('counts every Tavily call, not one per question', async () => {
      const { svc } = make({ attemptsPerSearch: 3, plan: 'one question about the thing' });
      const { spend } = await svc.run('a question');
      expect(spend.tavilySearches).toBe(3); // three attempts on ONE question, each a real credit
    });

    it('stops on the credit budget, not the question count', async () => {
      const plan = Array.from({ length: 8 }, (_, i) => `question number ${i} about the topic`).join('\n');
      const { svc, calls } = make({ attemptsPerSearch: 2, plan });
      const { spend } = await svc.run('a big question', { budget: { searches: 4, extracts: 1 } });
      // One question's whole sweep may finish after the ceiling is reached — bounded by the number
      // of indexes, not unbounded. It must never run away.
      expect(spend.searches).toBeLessThanOrEqual(4 + 3);
      expect(calls.searches).toBeLessThan(8);            // and it stopped well short of every question
    });

    // MEDIUM: a nested branch stacked the marker, and taking the first one dragged the parent's
    // focus along — reintroducing the bug this fix exists to remove, one level down.
    it('takes the innermost branch focus when branches are nested', () => {
      const nested = [
        'OVERALL RESEARCH GOAL (interpret every term and stay strictly within this):',
        'the whole ten part goal',
        '',
        'THIS BRANCH FOCUSES ON:',
        'branch A: market sizing',
        '',
        'THIS BRANCH FOCUSES ON:',
        'sub-branch A1: TAM in India',
      ].join('\n');
      const { focus } = DeepResearchService.splitFocus(nested);
      expect(focus).toBe('sub-branch A1: TAM in India');
      expect(focus).not.toContain('market sizing');
      expect(focus).not.toContain('THIS BRANCH FOCUSES ON');
    });
  });

  /**
   * BEA-1205. Brave leads because one call does search AND extraction; Tavily is kept for the two
   * things only it does well — a real date window and a list of sites to stay inside.
   */
  describe('every question sweeps EVERY index (BEA-1239)', () => {
    const withBrave = (over: any = {}) => make({ available: { tavily: true, exa: true, brave: true }, ...over });

    /**
     * This block used to assert the opposite — that one gatherer was CHOSEN per question by
     * heuristic. Measured head to head, Tavily/Exa/Brave shared only 3/6, 2/6 and on one question
     * 0/6 sources, so a question was answered from about a third of what we could see, and
     * "cannot be determined" was sometimes just the one index we happened to ask.
     */
    it('asks Tavily AND Exa AND Brave for the same question', async () => {
      const { svc, calls } = withBrave({ plan: 'how many students graduated' });
      await svc.run('a plain question');
      expect(calls.searches).toBe(1); // Tavily
      expect(calls.meaning).toBe(1);  // Exa
      expect(calls.brave).toBe(1);    // Brave
    });

    it('does not send a question to only one index, whatever it looks like', async () => {
      for (const plan of ['how many students graduated', 'what makes some people quietly give up on their own ideas']) {
        const { svc, calls } = withBrave({ plan });
        await svc.run('a plain question');
        const used = [calls.searches, calls.meaning, calls.brave].filter((n) => n > 0).length;
        expect(used).toBeGreaterThan(1);
      }
    });

    it('leaves Brave out when the owner STATED a date range — it cannot hold one', async () => {
      // BEA-1209 promises an explicit window is never widened. Brave has only a coarse freshness
      // setting, so including it would quietly widen the very thing the owner pinned.
      const { svc, calls } = withBrave({ plan: 'how many students graduated' });
      await svc.run('a plain question', { from: '2025-08-01' });
      expect(calls.brave).toBe(0);
      expect(calls.searches).toBe(1);
    });

    it('counts three sources found by three indexes ONCE when they are the same page', async () => {
      const same = [{ title: 'Same page', url: 'https://same.test/a', snippet: 'short' }];
      const { svc } = withBrave({ plan: 'one question here', results: { '*': same } });
      const { spend } = await svc.run('a plain question');
      expect(spend.sources).toBe(1); // three indexes, not three times the reading
    });

    it('never pays to re-read a page Brave already returned', async () => {
      const { svc, calls } = withBrave({ plan: 'how many students graduated', results: { '*': [{ title: 'p', url: 'https://b.test/1', snippet: 'short' }] } });
      await svc.run('a plain question');
      expect(calls.extracts).toBe(0);
    });

    it('prices each index honestly — Brave is not billed at Tavily rates', async () => {
      const { svc } = withBrave({ plan: 'how many students graduated' });
      const { report, spend } = await svc.run('a plain question');
      expect(spend.braveSearches).toBe(1);
      expect(spend.tavilySearches).toBe(1);
      expect(spend.meaningSearches).toBe(1);
      expect(report).toMatch(/1 on Brave \(search \+ read in one\)/);
    });

    it('names the index that failed instead of looking like a full sweep that found nothing', async () => {
      const web: any = {
        available: async () => ({ tavily: true, exa: false, brave: true }),
        search: async () => { throw new WebSearchError('tavily is over its quota'); },
        braveContext: async () => [{ title: 'p', url: 'https://b.test/1', snippet: 'short' }],
        readPage: async () => 'text',
      };
      const llm: any = { helperModel: async () => null, completeWithModel: async (_c: any, _p: string, _t: number, l: string) => ({ text: l === 'deep-research-plan' ? 'one question here' : 'the report [1].', model: 'x' }) };
      const lines: string[] = [];
      const { report } = await new DeepResearchService(web, llm).run('a plain question', { onLine: (t) => lines.push(t) });
      expect(report).toBeTruthy();
      expect(lines.join('\n')).toMatch(/Tavily: failed/);
    });
  });

  describe('the last resort', () => {
    /**
     * This test used to return a real result from the FIRST sweep, so the last resort never ran and
     * it was quietly re-testing "the normal sweep asks both indexes". The mocks now answer the
     * sub-question with nothing and only answer the owner's own wording, which is the whole point:
     * the sub-questions are a plan, and a plan can be wrong.
     */
    it('asks the question in the owner\'s OWN words before concluding nothing exists', async () => {
      const asked: string[] = [];
      const web: any = {
        available: async () => ({ tavily: true, exa: false, brave: true }),
        braveContext: async (q: string) => { asked.push(`brave:${q}`); return []; },
        search: async (q: string) => {
          asked.push(`tavily:${q}`);
          return q === 'something obscure the planner mangled'
            ? [{ title: 'Found by asking it your way', url: 'https://t.test/1', snippet: 's' }]
            : [];
        },
        readPage: async () => 'text',
      };
      const llm: any = { helperModel: async () => null, completeWithModel: async (_c: any, _p: string, _t: number, l: string) => ({ text: l === 'deep-research-plan' ? 'a badly worded sub question' : 'the report', model: 'x' }) };
      const lines: string[] = [];
      const { report } = await new DeepResearchService(web, llm).run('something obscure the planner mangled', { onLine: (t) => lines.push(t) });
      expect(lines.join('\n')).toMatch(/asking your question as you wrote it/);
      expect(asked).toContain('tavily:something obscure the planner mangled');
      expect(report).toContain('Found by asking it your way');
    });

    it('the last resort still obeys the budget — it cannot blow the ceiling', async () => {
      // Measured at 30 against a cap of 24 before this: the block fired unconditionally and added up
      // to five more charged calls, on exactly the "nothing found anywhere" path it exists for.
      const plan = Array.from({ length: 40 }, (_, i) => `question number ${i} about the topic`).join('\n');
      const { svc, calls } = make({ plan, results: { '*': [] }, available: { tavily: true, exa: true, brave: true }, attemptsPerSearch: 3 });
      const lines: string[] = [];
      const err: any = await svc.run('a big question', { budget: { searches: 999, extracts: 999 }, onLine: (t) => lines.push(t) }).catch((e: any) => e);
      // The honest guarantee: the ceiling stops NEW work starting, so a run can overshoot by at most
      // the sweep already in flight — one question across every index, worst case 5 calls. What it
      // must never do is add the last resort on top of an exhausted budget, which is what took a
      // measured run to 30.
      expect(err.spend.searches).toBeLessThanOrEqual(24 + 5);
      expect(lines.join('\n')).not.toMatch(/asking your question as you wrote it/);
      expect(calls.searches + calls.meaning + calls.brave).toBeLessThanOrEqual(24 + 5);
    });

    it('does NOT drop Brave just because the question mentions a year', async () => {
      // A window GUESSED from the wording is not a window the owner typed. Testing for any dates at
      // all silently dropped one of three indexes for most real questions.
      const { svc, calls } = make({ available: { tavily: true, exa: true, brave: true }, plan: 'engineering placements in 2025' });
      await svc.run('engineering placements in 2025');
      expect(calls.brave).toBe(1);
    });

    it('does drop Brave when the owner typed the dates', async () => {
      const { svc, calls } = make({ available: { tavily: true, exa: true, brave: true }, plan: 'engineering placements' });
      await svc.run('engineering placements', { from: '2025-08-01' });
      expect(calls.brave).toBe(0);
    });

    it('never pays to re-read a Brave page that another index returned under a different URL', async () => {
      // Same page, different raw string — the everyday case (www, trailing slash). Keyed by the raw
      // URL this quietly paid Tavily to open a page Brave had already handed over in full.
      const web: any = {
        available: async () => ({ tavily: true, exa: false, brave: true }),
        search: async () => [{ title: 'p', url: 'https://same.test/page', snippet: 'short' }],
        braveContext: async () => [{ title: 'p', url: 'https://www.same.test/page/', snippet: 'short' }],
        readPage: async () => { throw new Error('must not re-read what Brave already returned'); },
      };
      const llm: any = { helperModel: async () => null, completeWithModel: async (_c: any, _p: string, _t: number, l: string) => ({ text: l === 'deep-research-plan' ? 'one question here' : 'the report [1].', model: 'x' }) };
      const { report } = await new DeepResearchService(web, llm).run('a question about something');
      expect(report).toContain('the report [1].');
    });

    it('does not ask twice when only one index is connected', async () => {
      const { svc } = make({ available: { tavily: true, exa: false, brave: false }, results: { '*': [] }, plan: 'one question here' });
      await expect(svc.run('nothing findable')).rejects.toThrow(/found nothing to work from/);
    });
  });
});

/**
 * BEA-1209 — the owner can set a start and end date. The point is not the filter; it is what a
 * negative result MEANS. Without a window, "the sources do not cover this" cannot be told apart from
 * "we looked in the wrong years" — and his placement report turned on exactly that claim.
 */
describe('dates the owner sets (BEA-1209)', () => {
  it('reads two dates, and marks them as stated', () => {
    expect(DeepResearchService.statedWindow('2025-01-01', '2026-06-30')).toEqual({ start_date: '2025-01-01', end_date: '2026-06-30', stated: true });
  });

  it('accepts one end on its own — "since January" is a real request', () => {
    expect(DeepResearchService.statedWindow('2025-01-01', undefined)).toEqual({ start_date: '2025-01-01', end_date: undefined, stated: true });
    expect(DeepResearchService.statedWindow(undefined, '2026-06-30')).toEqual({ start_date: undefined, end_date: '2026-06-30', stated: true });
  });

  it('quietly fixes dates typed the wrong way round', () => {
    expect(DeepResearchService.statedWindow('2026-06-30', '2025-01-01')).toEqual({ start_date: '2025-01-01', end_date: '2026-06-30', stated: true });
  });

  it('ignores rubbish and empty fields, so the guess still runs', () => {
    expect(DeepResearchService.statedWindow(undefined, undefined)).toBeUndefined();
    expect(DeepResearchService.statedWindow('', '')).toBeUndefined();
    expect(DeepResearchService.statedWindow('last tuesday', 'soon')).toBeUndefined();
  });

  it('uses the owner\'s dates instead of guessing from the question', async () => {
    const seen: any[] = [];
    const web: any = {
      available: async () => ({ tavily: true, exa: false, brave: false }),
      search: async (_q: string, _m: number, o: any) => { seen.push(o.window); return [{ title: 'T', url: 'https://a', snippet: 's' }]; },
      readPage: async () => 'text',
    };
    const llm: any = { helperModel: async () => null, completeWithModel: async (_c: any, _p: string, _t: number, l: string) => ({ text: l === 'deep-research-plan' ? 'one question here' : 'report', model: 'x' }) };
    // The question says 2026; the owner says 2020-2021. The owner wins.
    await new DeepResearchService(web, llm).run('what happened in 2026', { from: '2020-01-01', to: '2021-12-31' });
    expect(seen[0]).toMatchObject({ start_date: '2020-01-01', end_date: '2021-12-31', stated: true });
  });

  it('blames the window, not the world, when the owner\'s period is empty', async () => {
    const web: any = {
      available: async () => ({ tavily: true, exa: false, brave: false }),
      search: async () => [],
      readPage: async () => '',
    };
    const llm: any = { helperModel: async () => null, completeWithModel: async () => ({ text: 'one question here', model: 'x' }) };
    const err: any = await new DeepResearchService(web, llm).run('anything', { from: '2020-01-01', to: '2020-12-31' }).catch((e: any) => e);
    expect(err.message).toMatch(/Nothing was published between 2020-01-01 and 2020-12-31/);
    expect(err.message).toMatch(/not a sign the information does not exist/);
  });
});

/**
 * BEA-1206 — planning and writing are different jobs and now use different models.
 *
 * Planning is "write me six search questions": ~320 tokens in, ~150 out. Sending that to the
 * subscription engine is worse than wasteful — a CLI call carries ~25,000 tokens of its own system
 * prompt, so a 470-token job would burn fifty times that from the allowance the writing needs.
 */
describe('planning and writing use their own models (BEA-1206)', () => {
  const spy = () => {
    const asked: string[] = [];
    const llm: any = {
      helperModel: async (k: string) => { asked.push(k); return { provider: 'openrouter', model: 'm-' + k }; },
      completeWithModel: async (_c: any, _p: string, _t: number, l: string) => ({ text: l === 'deep-research-plan' ? 'one question here' : 'the report', model: 'm-' + (l === 'deep-research-plan' ? 'deep-research-plan' : 'deep-research-write') }),
    };
    const web: any = {
      available: async () => ({ tavily: true, exa: false, brave: false }),
      search: async () => [{ title: 'T', url: 'https://a', snippet: 's' }],
      readPage: async () => 'text',
    };
    return { svc: new DeepResearchService(web, llm), asked };
  };

  it('asks for a planning model to plan and a writing model to write', async () => {
    const { svc, asked } = spy();
    await svc.run('a question');
    expect(asked).toContain('deep-research-plan');
    expect(asked).toContain('deep-research-write');
  });

  it('falls back to the old single setting rather than to nothing', async () => {
    const asked: string[] = [];
    const llm: any = {
      helperModel: async (k: string) => { asked.push(k); return k === 'deep-research' ? { provider: 'codex', model: 'codex' } : null; },
      completeWithModel: async (_c: any, _p: string, _t: number, l: string) => ({ text: l === 'deep-research-plan' ? 'one question here' : 'report', model: 'codex' }),
    };
    const web: any = { available: async () => ({ tavily: true, exa: false, brave: false }), search: async () => [{ title: 'T', url: 'https://a', snippet: 's' }], readPage: async () => 't' };
    const { report } = await new DeepResearchService(web, llm).run('a question');
    expect(asked).toContain('deep-research');   // the old key still resolves
    expect(report).toContain('report');
  });
});

/** BEA-1201 — moving from one FREE engine to another is not a paid call, and must not be reported as one. */
describe('a free fall-through is not a paid call (BEA-1201)', () => {
  const build = (flatRate: boolean) => {
    const web: any = { available: async () => ({ tavily: true, exa: false, brave: false }), search: async () => [{ title: 'T', url: 'https://a', snippet: 's' }], readPage: async () => 't' };
    const llm: any = {
      helperModel: async () => ({ provider: 'codex', model: 'codex' }),
      // Codex was dry, so Claude answered — a different model, still free.
      completeWithModel: async (_c: any, _p: string, _t: number, l: string) => ({ text: l === 'deep-research-plan' ? 'one question here' : 'report', model: 'claude', provider: 'claude', flatRate }),
    };
    return new DeepResearchService(web, llm);
  };

  it('counts nothing as paid when another free engine answered', async () => {
    const { spend, report } = await build(true).run('a question');
    expect(spend.paidCalls).toBe(0);
    expect(report).not.toMatch(/paid model/);
  });

  it('still counts it when the answer really did cost money', async () => {
    const { spend } = await build(false).run('a question');
    expect(spend.paidCalls).toBe(2);
  });
});

/**
 * BEA-1238 — the owner set "from 2025-08-01" and only ONE of three branches got it. The other two
 * searched with no limit at all, and the one that WAS limited found nothing and became the report.
 * The runner already reads a flow-level `graph.researchFrom`; nothing in the UI ever set it.
 */
describe('saying the date range in plain English (BEA-1238)', () => {
  const lines = async (over: any, opts: any) => {
    const out: string[] = [];
    const { svc } = make({ plan: 'one question here', ...over });
    await svc.run('a question about something', { ...opts, onLine: (t: string) => out.push(t) }).catch(() => undefined);
    return out.join('\n');
  };

  it('never prints "undefined" for an open end date', async () => {
    const said = await lines({}, { from: '2025-08-01' });
    expect(said).not.toContain('undefined');
    expect(said).toMatch(/onwards/);
    expect(said).toContain('(your dates)');
  });

  it('says it in words for an open START date too', async () => {
    const said = await lines({}, { to: '2025-08-01' });
    expect(said).not.toContain('undefined');
    expect(said).toMatch(/anything up to/);
  });

  it('reads as a range when both ends are given', async () => {
    const said = await lines({}, { from: '2025-01-01', to: '2025-12-31' });
    expect(said).not.toContain('undefined');
    expect(said).toMatch(/to/);
    expect(said).toContain('(your dates)');
  });

  it('does not claim they are YOUR dates when it guessed them', async () => {
    const out: string[] = [];
    const { svc } = make({ plan: 'one question here' });
    await svc.run('engineering placements in 2025', { onLine: (t: string) => out.push(t) }).catch(() => undefined);
    expect(out.join('\n')).not.toContain('(your dates)');
  });
});
