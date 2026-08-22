import { describe, expect, it } from '@jest/globals';
import { BriefPayload, briefInWords, buildHashOf, buildRequest, transcriptInWords } from './build-brief';
import { contractFromBrief, contractFromPlan } from './contract';
import { AgentPlan } from '../social/plan';

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
    expect(req.brief).toContain('These are the exact words he approved');
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
  it('turns "at least 20 mails read" into a real minimum', () => {
    const c = contractFromBrief(PLAN, ['At least 20 mails read. All three groups present.']);
    expect(c.minRows).toBe(20);
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
    expect(JSON.parse(req.files['contract.json']).minRows).toBe(20);
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
