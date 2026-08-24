import { describe, expect, it } from '@jest/globals';
import { BriefPayload, briefInWords, buildHashOf, buildRequest, transcriptInWords } from './build-brief';
import { ALLOW_EMPTY_NOTHING_MATCHED, contractFromBrief, contractFromPlan, contractInWords } from './contract';
import { ALL_PAGES, AgentPlan, MAX_PAGES, MAX_PAGES_ALL, clampPages, estimatePlanCost, pageCeiling, pagesText } from '../social/plan';

/**
 * Codex builds from the brief and the WHOLE conversation (BEA-1407).
 *
 * The owner decided this against my advice and he was right: a summary is a small form with better
 * handwriting, and losing his nuance is the disease. What makes sending everything safe is the brief
 * sitting on top as the decider, and every killed idea being marked rather than removed.
 */

const PLAN: AgentPlan = {
  name: 'Nightly email summary',
  sources: [{ kind: 'source', id: 'svc:gmail.fetch_emails', actionId: 'svc:gmail.fetch_emails', args: { query: 'newer_than:1d' }, pages: 1 }],
  merge: false,
  output: { kind: 'document', append: false },
  notify: { whatsapp: true, telegram: false },
  schedule: null,
  ceilingNote: 'the ceiling note',
  prompt: 'Sort them into work, personal and finance.',
  mode: 'run',
} as any;

const MESSAGE = 'Last night · 31 mails\n\nWork (14)\n• Ravi — quote needs a reply today\n\nPersonal (9)\n• Amma — call back\n\nFinance (8)\n• HDFC — statement ready';

function payload(over: Partial<BriefPayload['brief']> = {}, transcript: any[] = []): BriefPayload {
  return {
    decides: 'The brief below is what the owner read and approved. … Where the two disagree, THE BRIEF WINS. … Never build a struck thing.',
    brief: {
      name: 'Nightly email summary',
      version: 1,
      approvedAt: '2026-08-22T18:00:00.000Z',
      sections: [
        { key: 'want', label: 'What I want', lines: [{ text: 'Read all my important emails and WhatsApp me a summary grouped into work, personal and finance.', origin: 'owner' }] },
        { key: 'filter', label: 'What counts, what to ignore', lines: [{ text: 'Skip newsletters.', origin: 'ai' }] },
        { key: 'output', label: 'What to do with it', lines: [{ text: 'Also post it to Telegram.', origin: 'ai', struck: true }] },
        { key: 'success', label: 'What "it worked" means', lines: [{ text: 'At least 20 mails read. All three groups present.', origin: 'owner' }] },
      ],
      sources: [{ id: 'svc:gmail.fetch_emails', actionId: 'svc:gmail.fetch_emails', args: {}, saw: 'I looked at Gmail and got 47 emails.' }],
      delivery: { whatsapp: true, telegram: false, messageText: MESSAGE },
      ...over,
    } as any,
    transcript,
  };
}

const MATERIALS = {
  job: { id: 'j1', name: 'Nightly email summary' },
  plan: PLAN,
  cards: [] as any[],
  samples: [] as any[],
  kit: { version: '1.0.0', js: '// kit', doc: '# kit' },
  version: 1,
};

describe('what Codex is given', () => {
  it('ships the brief, the whole conversation, and says the brief decides', () => {
    const turns = [
      { id: 't1', who: 'you', text: 'Read all my important emails.', at: '' },
      { id: 't2', who: 'ai', text: 'I could also post it to Telegram.', at: '', struck: true },
      { id: 't3', who: 'you', text: 'No Telegram.', at: '' },
    ];
    const req = buildRequest({ ...MATERIALS, brief: payload({}, turns) } as any);

    expect(req.files['BRIEF.md']).toBeTruthy();
    expect(req.files['conversation.md']).toBeTruthy();
    expect(req.files['brief.json']).toBeTruthy();

    // Every turn, nothing summarised.
    for (const t of turns) expect(req.files['conversation.md']).toContain(t.text);
    // The killed one is present AND marked, so nothing rebuilds it.
    expect(req.files['conversation.md']).toContain('KILLED');
    // And the rule that makes sending the whole transcript safe is in the build brief itself.
    expect(req.brief).toContain('THE BRIEF WINS');
    expect(req.brief).toContain('Never build a struck thing');
  });

  it('keeps each line\'s tag, so a guess cannot read as an instruction', () => {
    const text = briefInWords(payload());
    expect(text).toContain('[HIS WORDS]');
    expect(text).toContain('[a guess]');
    // The struck line is struck through AND labelled, not quietly dropped.
    expect(text).toMatch(/~~Also post it to Telegram\.~~ \*\*\(KILLED/);
  });

  // ---- the message: the whole point ---------------------------------------------------------------

  it('hands over the exact message he approved, and forbids a row count', () => {
    const req = buildRequest({ ...MATERIALS, brief: payload() } as any);
    expect(req.brief).toContain('Work (14)');
    expect(req.brief).toContain('• Ravi — quote needs a reply today');
    expect(req.brief).toContain('This is the shape he approved');
    expect(req.brief).toContain('never a row count');
  });

  it('says plainly when nothing is sent', () => {
    const text = briefInWords(payload({ delivery: { whatsapp: false, telegram: false, messageText: '' } } as any));
    expect(text).toContain('Nothing is sent');
  });

  // ---- the old road is not closed ------------------------------------------------------------------

  it('a job with no brief is built from the plan, exactly as before', () => {
    const req = buildRequest({ ...MATERIALS } as any);
    expect(req.files['BRIEF.md']).toBeUndefined();
    expect(req.files['conversation.md']).toBeUndefined();
    expect(req.brief).not.toContain('THE BRIEF WINS');
    expect(req.brief).toContain('## The plan');
  });

  it('and its hash is unchanged, so no existing worker is marked stale by this', () => {
    expect(buildHashOf(PLAN, null)).toBe(buildRequest({ ...MATERIALS } as any).planHash);
  });
});

describe('staleness follows the brief too', () => {
  it('a new approved version of the brief makes the worker stale', () => {
    const a = buildHashOf(PLAN, payload());
    const b = buildHashOf(PLAN, payload({ version: 2, approvedAt: '2026-08-23T09:00:00.000Z' } as any));
    expect(a).not.toBe(b);
  });

  it('changing the message he will receive makes it stale too', () => {
    const a = buildHashOf(PLAN, payload());
    const b = buildHashOf(PLAN, payload({ delivery: { whatsapp: true, telegram: false, messageText: 'something else' } } as any));
    expect(a).not.toBe(b);
  });

  it('the same brief twice is the same hash — a rebuild is not forced for nothing', () => {
    expect(buildHashOf(PLAN, payload())).toBe(buildHashOf(PLAN, payload()));
  });
});

describe('the contract comes from HIS words', () => {
  it('turns "at least 20 mails read" into a real minimum on what it READS', () => {
    // This test used to assert `minRows: 20`, and the first real trial run proved that wrong: the
    // run read 15 real emails, kept the 5 that mattered, and was failed for keeping 5.
    const c = contractFromBrief(PLAN, ['At least 20 mails read. All three groups present.']);
    expect(c.minFetched).toBe(20);
    // The plan alone could only ever have asked for one row — which is how one email a night passed.
    expect(contractFromPlan(PLAN).minRows).toBe(1);
  });

  it('reads "more than 20" as 21, because that is what the words mean', () => {
    expect(contractFromBrief(PLAN, ['More than 20 rows.']).minRows).toBe(21);
  });

  it('takes the strictest floor he wrote', () => {
    expect(contractFromBrief(PLAN, ['At least 50 rows.', 'At least 20 mails.']).minRows).toBe(20);
  });

  it('says nothing it cannot read with certainty — a check that fails a good run is worse than none', () => {
    const c = contractFromBrief(PLAN, ['It should feel useful and be nicely written.']);
    expect(c.minRows).toBe(contractFromPlan(PLAN).minRows);
    expect(c.columns).toEqual([]);
  });

  it('an empty success section leaves the plan\'s own contract alone', () => {
    expect(contractFromBrief(PLAN, [])).toEqual(contractFromPlan(PLAN));
  });

  it('a struck success line does not count', () => {
    const req = buildRequest({
      ...MATERIALS,
      brief: payload({
        sections: [
          { key: 'success', label: 'What "it worked" means', lines: [{ text: 'At least 20 mails read.', origin: 'owner', struck: true }] },
        ],
      } as any),
    } as any);
    expect(JSON.parse(req.files['contract.json']).minRows).toBe(contractFromPlan(PLAN).minRows);
  });

  it('the contract is written by the app — Codex is told not to touch it', () => {
    const req = buildRequest({ ...MATERIALS, brief: payload() } as any);
    expect(req.files['contract.json']).toBeTruthy();
    expect(req.brief).toContain('Do not write it, do not edit it');
    expect(JSON.parse(req.files['contract.json']).minFetched).toBe(20);
  });
});

describe('the conversation, written out', () => {
  it('names who said what and keeps the order', () => {
    const text = transcriptInWords([
      { id: '1', who: 'you', text: 'first', at: '' },
      { id: '2', who: 'ai', text: 'second', at: '' },
    ] as any);
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text).toContain('**HIM**');
    expect(text).toContain('**THE BUILDER**');
  });
});

/**
 * "Read ALL my emails since yesterday" (BEA-1407).
 *
 * The plan had a page count, capped at 11, and a count is a guess about how much of somebody's life
 * fits on a page. `ALL_PAGES` is how the brief says "until it runs out" — bounded by the source
 * itself, by a runaway backstop, and by the daily credit ceiling, checked before every page.
 */
describe('"every page there is"', () => {
  it('reads the word "all" as a real instruction', () => {
    expect(clampPages('all')).toBe(ALL_PAGES);
    expect(clampPages(ALL_PAGES)).toBe(ALL_PAGES);
  });

  it('still caps an ordinary number, so nothing else changes', () => {
    expect(clampPages(3)).toBe(3);
    expect(clampPages(99)).toBe(MAX_PAGES);
    expect(clampPages('rubbish')).toBe(1);
    expect(clampPages(0)).toBe(1);
  });

  it('has a runaway backstop, and it is far above any real source', () => {
    expect(pageCeiling(ALL_PAGES)).toBe(MAX_PAGES_ALL);
    expect(MAX_PAGES_ALL).toBeGreaterThan(MAX_PAGES * 10);
    expect(pageCeiling(3)).toBe(3);
  });

  it('says so in plain words rather than printing -1 at him', () => {
    expect(pagesText(ALL_PAGES)).toBe('every page there is');
    expect(pagesText(1)).toBe('1 page');
    expect(pagesText(4)).toBe('4 pages');
  });

  it('costs it as a floor, never as a number it cannot know', () => {
    const all = { ...PLAN, sources: [{ ...(PLAN.sources[0] as any), pages: ALL_PAGES }] } as AgentPlan;
    const cost = estimatePlanCost(all, {});
    expect(cost.how).toContain('every page there is');
    expect(cost.how).toContain('or more');
    expect(cost.how).toContain('daily ceiling');
  });
});

/**
 * Reading and keeping are different numbers (BEA-1410).
 *
 * Found on the FIRST real trial run, on his real inbox — which is exactly what the gate is for.
 * His sentence was *"at least 10 emails read"*. The run fetched 15 real emails, filtered them to the
 * 5 that mattered, and was failed for producing 5 — while doing precisely what he asked. A check
 * that fails a good run is worse than no check, so the words around the number now decide.
 */
describe('"read" and "kept" are not the same promise', () => {
  it('"at least 10 emails read" is about the fetch, not the result', () => {
    const c = contractFromBrief(PLAN, ['At least 10 emails read.']);
    expect(c.minFetched).toBe(10);
    expect(c.minRows).toBe(contractFromPlan(PLAN).minRows); // untouched
  });

  it('"at least 10 rows" is about the result', () => {
    const c = contractFromBrief(PLAN, ['At least 10 rows in the sheet.']);
    expect(c.minRows).toBe(10);
    expect(c.minFetched).toBeFalsy();
  });

  it('one sentence can carry both, and they do not collide', () => {
    const c = contractFromBrief(PLAN, ['It should read at least 20 emails and keep at least 3 rows.']);
    expect(c.minFetched).toBe(20);
    expect(c.minRows).toBe(3);
  });

  it('the other reading words count too', () => {
    for (const said of ['At least 10 fetched.', 'It goes through at least 10.', 'At least 10 scanned.', 'It looked at at least 10.']) {
      expect(contractFromBrief(PLAN, [said]).minFetched).toBe(10);
    }
  });

  it('says the reading promise in plain words, first', () => {
    const words = contractInWords(contractFromBrief(PLAN, ['At least 10 emails read.']));
    expect(words[0]).toContain('go through at least 10');
  });
});

/**
 * The message he receives may not contain instructions (BEA-1410).
 *
 * Found on the third real trial run. His approved shape carried a line telling the builder how to
 * fill it in — *"Put each email under ONE heading only…"* — and Codex, correctly told that the shape
 * is literal, sent that line to his phone along with the summary. A rule about how to build the
 * message is noise on a phone.
 */
describe('the shape and the rules about it are different things', () => {
  it('tells Codex what a hole is, and that rules must not be sent', () => {
    const req = buildRequest({ ...MATERIALS, brief: payload() } as any);
    expect(req.brief).toContain('<angle brackets> is a hole to fill');
    expect(req.brief).toContain('Nothing that reads as an instruction may end up in the message he receives');
  });

  it('still insists the shape itself is sent, not a summary of it', () => {
    const req = buildRequest({ ...MATERIALS, brief: payload() } as any);
    expect(req.brief).toContain('never a row count');
    expect(req.brief).toContain('filled in with the real data');
  });
});

/**
 * "Nothing mattered today" is not "we could not read it" (BEA-1456).
 *
 * His nightly email agent ran on a Sunday. Gmail gave 8 real emails. The recipe read all 8. The
 * thinking step judged none of them important — a newsletter, some updates — and the run told him:
 *
 *   "Nothing usable came back: 1 source answered but recognised 0 rows."
 *
 * That sentence means *we* could not read what the vendor sent. It was a lie: we read all eight.
 * Reading nothing is our bug; keeping nothing is an answer about his day. They must never wear the
 * same words.
 *
 * And his brief contained the contradiction that made it worse: *"at least 5 emails summarised"* in
 * one line, *"if there are fewer, still post what there is and say so"* in the next. Reading only
 * the first turned the second into a promise the run broke.
 */
describe('a quiet day', () => {
  it('is a good day when he said so anywhere in the brief', () => {
    const c = contractFromBrief(PLAN, ['At least 5 emails summarised.'], ['If there are fewer than 5, still post what there is and say so.']);
    expect(c.minRows).toBe(0);
    expect(c.allowEmptyWhen).toBe(ALLOW_EMPTY_NOTHING_MATCHED);
  });

  it('takes the kinder reading when two of his lines disagree', () => {
    // "At least 5" alone would fail a quiet day and write nothing — breaking the very next line.
    expect(contractFromBrief(PLAN, ['At least 5 emails summarised.']).minRows).toBe(5);
    expect(contractFromBrief(PLAN, ['At least 5 emails summarised.'], ['Still send it even if there are none.']).minRows).toBe(0);
  });

  it('reads the other ways he might say it', () => {
    for (const said of ['Even if there are no important emails, still create the page.', 'A quiet day is fine.', 'Post it even if only one.', 'If nothing is important, say so.']) {
      expect(contractFromBrief(PLAN, [said]).minRows).toBe(0);
    }
  });

  it('leaves a strict brief strict — he has to actually say it', () => {
    const c = contractFromBrief(PLAN, ['At least 20 rows.'], ['Tell me on WhatsApp if it breaks.']);
    expect(c.minRows).toBe(20);
    expect(c.allowEmptyWhen).not.toBe(ALLOW_EMPTY_NOTHING_MATCHED);
  });

  it('still keeps the columns he named', () => {
    const c = contractFromBrief(PLAN, ['Columns: sender, subject, link. A quiet day is fine.']);
    expect(c.minRows).toBe(0);
    expect(c.columns).toEqual(expect.arrayContaining(['sender', 'subject', 'link']));
  });
});
