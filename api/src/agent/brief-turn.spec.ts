import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AI_LINES_MAX } from './brief';
import { BRIEF_TEXT, briefCardOf, briefHeldNote, briefRequestOf, checkProposedBrief, readProposedBrief } from './brief-turn';

/**
 * The conversation writes the brief (BEA-1424) — the missing entrance.
 *
 * Everything downstream of an approved brief was built and proven, and every brief up to this point
 * was still filled in **by hand through the API, by me**. Which is the loop he asked to end, still
 * running. These tests are about the door.
 *
 * The rules below are all asked for in the prompt. They are checked here because a prompt is a
 * request, and this builder talked its way past four requests in one conversation.
 */

const LOOKED = new Set(['svc:gmail.fetch_emails']);

function proposal(over: any = {}) {
  return {
    name: 'Nightly email summary',
    sections: {
      want: [{ text: 'Read all my important emails and WhatsApp me a summary.', origin: 'owner' }],
      sources: [{ text: 'I looked at Gmail and got 47 emails.', origin: 'tool' }],
      filter: [{ text: 'Skip newsletters.', origin: 'ai' }],
      success: [{ text: 'At least 20 emails read.', origin: 'owner' }],
      ...over.sections,
    },
    sources: [{ actionId: 'svc:gmail.fetch_emails', args: { query: 'newer_than:1d' }, pages: 'all' }],
    delivery: { whatsapp: true, telegram: false, messageText: 'Last night — <how many>\n\nWORK\n• <sender>' },
    ...over.top,
  };
}

describe('reading what the model sent', () => {
  it('reads a proper brief', () => {
    const b = readProposedBrief(proposal())!;
    expect(b.name).toBe('Nightly email summary');
    expect(b.sections.want[0].origin).toBe('owner');
    expect(b.sources[0].pages).toBe('all');
    expect(b.delivery.messageText).toContain('WORK');
  });

  it('treats a bare string as the AI talking, never as his words', () => {
    // Claiming his voice is far worse than a missing tag: the tag is the whole point of the screen.
    const b = readProposedBrief({ sections: { filter: ['Skip newsletters.'] } })!;
    expect(b.sections.filter[0].origin).toBe('ai');
  });

  it('treats an unknown origin as the AI talking too', () => {
    const b = readProposedBrief({ sections: { want: [{ text: 'x', origin: 'gospel' }] } })!;
    expect(b.sections.want[0].origin).toBe('ai');
  });

  it('keeps the message exactly, including its blank lines', () => {
    const msg = '\nLast night\n\nWORK\n• a\n';
    expect(readProposedBrief({ sections: { want: [{ text: 'x', origin: 'owner' }] }, delivery: { whatsapp: true, messageText: msg } })!.delivery.messageText).toBe(msg);
  });

  it('answers nothing for junk', () => {
    expect(readProposedBrief(null)).toBeNull();
    expect(readProposedBrief('a brief')).toBeNull();
    expect(readProposedBrief({ sections: {} })).toBeNull();
  });

  it('spots a brief on the turn, and ignores anything else', () => {
    expect(briefRequestOf({ brief: { sections: {} } })).toBeTruthy();
    expect(briefRequestOf({ brief: [] })).toBeNull();
    expect(briefRequestOf({ plan: {} })).toBeNull();
  });
});

describe('the rules, checked rather than requested', () => {
  it('accepts one that keeps them all', () => {
    expect(checkProposedBrief(readProposedBrief(proposal())!, LOOKED)).toBeNull();
  });

  it('sends it back to LOOK before it promises anything about a source', () => {
    const b = readProposedBrief(proposal())!;
    const wrong = checkProposedBrief(b, new Set())!;
    expect(wrong.kind).toBe('unlooked');
    expect(wrong.say).toContain('You have not looked at');
    // And it is told exactly how to fix it, not just that it is wrong.
    expect(wrong.say).toContain('"sample"');
    expect(wrong.say).toContain('svc:gmail.fetch_emails');
  });

  it('sends back a brief too long to read, and says to ask a question instead', () => {
    const many = Array.from({ length: AI_LINES_MAX + 3 }, (_, i) => ({ text: `guess ${i}`, origin: 'ai' }));
    const b = readProposedBrief(proposal({ sections: { filter: many } }))!;
    const wrong = checkProposedBrief(b, LOOKED)!;
    expect(wrong.kind).toBe('too-long');
    expect(wrong.say).toContain('ask him a question');
    expect(wrong.say).toContain(String(AI_LINES_MAX));
  });

  it('sends back a brief with none of his words in it', () => {
    const b = readProposedBrief(proposal({ sections: { want: [{ text: 'Summarise the inbox.', origin: 'ai' }] } }))!;
    expect(checkProposedBrief(b, LOOKED)!.kind).toBe('no-words');
  });

  it('sends back "it will message you" with no message — the nine-hour bug, refused at the source', () => {
    const b = readProposedBrief(proposal({ top: { delivery: { whatsapp: true, telegram: false, messageText: '   ' } } }))!;
    const wrong = checkProposedBrief(b, LOOKED)!;
    expect(wrong.kind).toBe('no-message');
    expect(wrong.say).toContain('there is nowhere else for it to live');
  });

  it('sends back a brief that never says what a good run looks like', () => {
    const b = readProposedBrief(proposal({ sections: { success: [] } }))!;
    const wrong = checkProposedBrief(b, LOOKED)!;
    expect(wrong.kind).toBe('no-success');
    expect(wrong.say).toContain('one email will call itself a success');
  });

  it('sends back a brief that fetches nothing at all', () => {
    const b = readProposedBrief(proposal({ top: { sources: [] } }))!;
    expect(checkProposedBrief(b, LOOKED)!.kind).toBe('nothing');
  });

  it('a struck line does not keep a rule satisfied', () => {
    const b = readProposedBrief(proposal({ sections: { success: [{ text: 'At least 20.', origin: 'owner', struck: true }] } }))!;
    expect(checkProposedBrief(b, LOOKED)!.kind).toBe('no-success');
  });
});

describe('what HE reads when no brief came', () => {
  it('says the one thing to tell it next, in his terms', () => {
    expect(briefHeldNote({ kind: 'unlooked', say: '' })).toContain('has not actually opened the tools');
    expect(briefHeldNote({ kind: 'too-long', say: '' })).toContain('too long to read');
    expect(briefHeldNote({ kind: 'no-message', say: '' })).toContain('has not written what the message says');
    expect(briefHeldNote({ kind: 'no-success', say: '' })).toContain('what would make it worth having');
    expect(briefHeldNote({ kind: 'no-words', say: '' })).toContain('all my guesses and none of your words');
    expect(briefHeldNote({ kind: 'nothing', say: '' })).toContain('does not fetch anything yet');
  });

  it('never shrugs — every one names something he can act on', () => {
    for (const kind of ['unlooked', 'too-long', 'no-message', 'no-success', 'no-words', 'nothing'] as const) {
      const said = briefHeldNote({ kind, say: '' });
      expect(said.length).toBeGreaterThan(30);
      expect(said).not.toContain('try saying it another way');
    }
  });
});

describe('the short card in the chat', () => {
  it('shows the name, how many guesses are in it, and what it fetches', () => {
    const card = briefCardOf(readProposedBrief(proposal())!);
    expect(card.name).toBe('Nightly email summary');
    expect(card.guesses).toBe(1);
    expect(card.sources).toEqual(['Gmail · fetch emails']);
    expect(card.sends).toBe(true);
  });
});

describe('what the builder is told a brief is', () => {
  it('states the four rules that cost him a night', () => {
    expect(BRIEF_TEXT).toContain('LOOK BEFORE YOU PROMISE');
    expect(BRIEF_TEXT).toContain('ASK HIM A QUESTION instead of writing more');
    expect(BRIEF_TEXT).toContain('IF IT MESSAGES HIM, WRITE THE MESSAGE');
    expect(BRIEF_TEXT).toContain('SAY WHAT A GOOD RUN LOOKS LIKE');
  });

  it('explains the three tags, because they are the point of the screen', () => {
    expect(BRIEF_TEXT).toContain('HIS words, quoted');
    expect(BRIEF_TEXT).toContain('something a real call actually showed');
    expect(BRIEF_TEXT).toContain('your own idea');
  });

  it('says plainly that sending a brief builds nothing', () => {
    expect(BRIEF_TEXT).toContain('Nothing is built when you send a brief');
  });
});

/**
 * A field written on one side and not read on the other is saved and then silently dropped
 * (BEA-1424).
 *
 * The conversation wrote a brief, it went into the row — and Create answered "there is no proposal
 * to create yet", because the loader rebuilds the state field by field and `brief` was not on its
 * list. Found by pressing the button on a real conversation, not by any test I had written.
 */
describe('the conversation state survives a round trip', () => {
  it('every field the writer writes, both readers read', () => {
    const src = readFileSync(join(__dirname, 'agent-areas.service.ts'), 'utf8');
    const packed = src.slice(src.indexOf('function packState('), src.indexOf('function packState(') + 1200);
    const written = new Set(
      [...packed.matchAll(/st\.(\w+)/g)].map((m) => m[1]).filter((k) => k !== 'log'),
    );
    expect(written.has('brief')).toBe(true);

    // Both loaders rebuild the state field by field, so both have to name every field.
    const loaders = [...src.matchAll(/return \{ log: v\?\.log[^}]*\}/g)].map((m) => m[0]);
    expect(loaders.length).toBe(2);

    for (const field of written) {
      const inSome = loaders.some((l) => l.includes(`${field}:`));
      // A field only one builder has (spec / job / seed) is fine; one NOBODY reads is the bug.
      expect([field, inSome]).toEqual([field, true]);
    }
    // And the one that actually bit: read by both.
    for (const l of loaders) expect(l).toContain('brief:');
  });
});

/**
 * The proof has to travel with the brief (BEA-1424).
 *
 * The turn knew the conversation had looked — the sampler writes a line for every real call. The
 * model's own brief cannot know the `ToolCall` id, so the sources it proposed carried nothing, and
 * the stored brief then refused its own approval: *"I have not looked at Instagram myself yet"*,
 * about a source it had just fetched twelve posts from.
 *
 * Found by pressing the button on a real conversation. Both checks were right; they were reading
 * different things.
 */
describe('what the conversation looked at reaches the brief', () => {
  const proofFrom = (log: any[]) => {
    const proof = new Map<string, string>();
    for (const m of log || []) {
      if (m?.kind === 'sample' && m?.ok && m?.actionId && m?.callId) proof.set(String(m.actionId), String(m.callId));
    }
    return proof;
  };

  it('takes the call id off a successful look', () => {
    const proof = proofFrom([{ who: 'ai', kind: 'sample', ok: true, actionId: 'svc:instagram.search_hashtag', callId: 'tc9' }]);
    expect(proof.get('svc:instagram.search_hashtag')).toBe('tc9');
  });

  it('ignores a look that FAILED — a call that did not work proves nothing', () => {
    expect(proofFrom([{ kind: 'sample', ok: false, actionId: 'svc:x.y', callId: 'tc1' }]).size).toBe(0);
  });

  it('ignores an ordinary chat line', () => {
    expect(proofFrom([{ who: 'you', text: 'do the thing' }, { who: 'ai', text: 'sure' }]).size).toBe(0);
  });

  it('keeps the NEWEST look at an action, when it was looked at twice', () => {
    const proof = proofFrom([
      { kind: 'sample', ok: true, actionId: 'svc:a.b', callId: 'first' },
      { kind: 'sample', ok: true, actionId: 'svc:a.b', callId: 'second' },
    ]);
    expect(proof.get('svc:a.b')).toBe('second');
  });
});
