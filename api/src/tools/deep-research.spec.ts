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
      calls.searches++; calls.meaning++; opts.onSearch?.(q, 'meaning');
      return opts.results?.[q] ?? opts.results?.['*'] ?? [{ title: 'A page', url: `https://m.test/${calls.searches}`, snippet: 'short' }];
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
    })),
    completeHelper: jest.fn(async (_k: string, _p: string, _t: number, label: string) => answer(label)),
  };
  return { svc: new DeepResearchService(web, llm), calls, llm };
}

describe('deep research (BEA-1196)', () => {
  it('plans, searches, reads and writes — with the sources appended', async () => {
    const { svc, calls } = make();
    const { report, spend } = await svc.run('what is changing in fresher hiring');
    expect(calls.searches).toBe(3);
    expect(report).toContain('The report body [1].');
    expect(report).toContain('### Sources');
    expect(report).toContain('https://x.test/1');       // the links must reach the saved document
    expect(spend).toMatchObject({ searches: 3, extracts: 3 });
    expect(spend.sources).toBe(3);
  });

  // The whole reason the owner rejected Perplexity was cost. A step that can quietly do 40 searches
  // rebuilds that problem in our own code.
  it('never exceeds its search budget, however many questions the model proposes', async () => {
    const plan = Array.from({ length: 30 }, (_, i) => `question number ${i} about the topic`).join('\n');
    const { svc, calls } = make({ plan });
    const { spend } = await svc.run('a big question', { budget: { searches: 2, extracts: 1 } });
    expect(calls.searches).toBe(2);
    expect(calls.extracts).toBe(1);
    expect(spend).toMatchObject({ searches: 2, extracts: 1 });
  });

  it('clamps a silly budget to the hard cap instead of trusting it', async () => {
    const plan = Array.from({ length: 40 }, (_, i) => `question number ${i} about the topic`).join('\n');
    const { svc, calls } = make({ plan });
    await svc.run('a big question', { budget: { searches: 999, extracts: 999 } });
    expect(calls.searches).toBeLessThanOrEqual(8);
    expect(calls.extracts).toBeLessThanOrEqual(10);
  });

  // A retried node would otherwise search three times over and report zero spend.
  it('still reports what it spent when it fails', async () => {
    const { svc } = make({ results: { '*': [] } });
    const err: any = await svc.run('nothing findable').catch((e: any) => e);
    expect(err.spend).toMatchObject({ searches: 3, sources: 0 });
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
    expect(spend.sources).toBe(1);       // three searches, one unique page
    expect(spend.searches).toBe(3);
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
    expect(spend.sources).toBe(3);
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
    expect(report).toMatch(/3 searches \+ 3 page reads \(6 Tavily credits/);
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
      expect(lines.join('\n')).toMatch(/your own engine was unavailable/);
      expect(report).toMatch(/used the paid model/);
    });

    it('reports nothing paid on the normal path', async () => {
      const { svc } = make();
      const { report, spend } = await svc.run('a question about something');
      expect(spend.paidCalls).toBe(0);
      expect(report).not.toMatch(/paid model/);
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
    expect(spend).toMatchObject({ searches: 3, meaningSearches: 1 });
    expect(report).toMatch(/4 Tavily credits/);   // 2 keyword searches × 2, NOT 6
    expect(report).toMatch(/1 of them on Exa/);
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
      expect(writePrompt).toContain('You were given 3 source(s)');
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
      expect(spend.searches).toBe(3);
    });

    it('stops on the credit budget, not the question count', async () => {
      const plan = Array.from({ length: 8 }, (_, i) => `question number ${i} about the topic`).join('\n');
      const { svc, calls } = make({ attemptsPerSearch: 2, plan });
      const { spend } = await svc.run('a big question', { budget: { searches: 4, extracts: 1 } });
      expect(spend.searches).toBeLessThanOrEqual(4 + 1); // never runs away; one in-flight question may finish
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
  describe('choosing the gatherer', () => {
    const withBrave = (over: any = {}) => make({ available: { tavily: true, exa: true, brave: true }, ...over });

    it('leads with Brave when nothing needs precision', async () => {
      const { svc, calls } = withBrave({ plan: 'how many students graduated' });
      await svc.run('a plain question');
      expect(calls.brave).toBe(1);
      expect(calls.searches).toBe(0);
    });

    it('uses Tavily when a date window is in play — Brave cannot pin one', async () => {
      const { svc, calls } = withBrave({ plan: 'how many students graduated' });
      await svc.run('placements in 2025 and 2026');
      expect(calls.searches).toBe(1);
      expect(calls.brave).toBe(0);
    });

    it('uses Tavily when the planner named sites to stay inside', async () => {
      const { svc, calls } = withBrave({ plan: 'how many students graduated\nsites: aicte-india.org' });
      await svc.run('a plain question');
      expect(calls.searches).toBe(1);
      expect(calls.brave).toBe(0);
    });

    it('still sends a keyword-less question to Exa', async () => {
      const { svc, calls } = withBrave({ plan: 'what makes some people quietly give up on their own ideas' });
      await svc.run('a plain question');
      expect(calls.meaning).toBe(1);
      expect(calls.brave).toBe(0);
    });

    it('never pays to re-read a page Brave already returned', async () => {
      // Brave hands back the page content with the search. A live run still spent two Tavily
      // extracts on Brave sources before this — money for text we already had.
      const { svc, calls } = withBrave({ plan: 'how many students graduated' });
      await svc.run('a plain question');
      expect(calls.extracts).toBe(0);
    });

    it('prices Brave separately — it is not billed at Tavily rates', async () => {
      const { svc } = withBrave({ plan: 'how many students graduated' });
      const { report, spend } = await svc.run('a plain question');
      expect(spend.braveSearches).toBe(1);
      expect(report).toMatch(/1 on Brave \(search \+ read in one\)/);
      expect(report).not.toMatch(/2 Tavily credits/); // the Brave call is not a Tavily credit
    });

    /**
     * The 0/6 overlap finding. Brave and Tavily returned completely different sources on one real
     * question, so one index drawing a blank is weak evidence. "This does not exist publicly" is the
     * most consequential sentence this tool writes.
     */
    it('asks the other index before concluding nothing exists', async () => {
      let asked = 0;
      const web: any = {
        available: async () => ({ tavily: true, exa: false, brave: true }),
        braveContext: async () => { asked++; return []; },
        search: async () => { asked++; return [{ title: 'Found by the other index', url: 'https://t.test/1', snippet: 's' }]; },
        readPage: async () => 'text',
      };
      const llm: any = { helperModel: async () => null, completeWithModel: async (_c: any, _p: string, _t: number, l: string) => ({ text: l === 'deep-research-plan' ? 'one question here' : 'the report', model: 'x' }) };
      const { report } = await new DeepResearchService(web, llm).run('something obscure');
      expect(asked).toBe(2);                                   // Brave, then Tavily
      expect(report).toContain('Found by the other index');
    });

    it('does not ask twice when only one index is connected', async () => {
      const { svc } = make({ available: { tavily: true, exa: false, brave: false }, results: { '*': [] }, plan: 'one question here' });
      await expect(svc.run('nothing findable')).rejects.toThrow(/found nothing to work from/);
    });
  });
});
