import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AI_LINES_MAX, briefToAgentInput } from './brief';
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

/**
 * ONE ROAD (BEA-1453) — his instruction: *"remove the old road, make everything go through the
 * brief."*
 *
 * He built his first real agent and it never touched any of this: 0 briefs, 0 trials, 0 Codex
 * builds. The conversation said *"this needs real thinking, so I'll build it as an agent with a job,
 * not a fixed data pull"* — and that one sentence routed him past the brief, the trial and the gate,
 * created the agent switched ON, and let a third model draw its flow half a minute later.
 */
describe('a brief can describe an agent that WRITES, not only one that reads', () => {
  const brief = (over: any = {}) => ({
    name: 'Email digest',
    sections: {
      want: [{ id: '1', text: 'Summarise my important emails into a Notion page each night.', origin: 'owner' }],
      filter: [], output: [], sources: [], when: [], success: [], trouble: [], killed: [],
    },
    sources: [{ id: 'svc:gmail.fetch_emails', actionId: 'svc:gmail.fetch_emails', args: {} }],
    tools: ['svc:notion.create_notion_page', 'svc:notion.add_multiple_page_content'],
    delivery: { whatsapp: true, telegram: false, messageText: 'Tonight — <n> emails\n<link>' },
    ...over,
  }) as any;

  it('carries what it WRITES with, not only where it reads from', () => {
    // Without this a brief could only ever describe reading — which is exactly why his Notion job
    // had to take the old road.
    const input = briefToAgentInput(brief());
    expect(input.tools).toContain('svc:notion.create_notion_page');
    expect(input.tools).toContain('svc:notion.add_multiple_page_content');
    expect(input.tools).toContain('svc:gmail.fetch_emails');
  });

  it('lists every action exactly once, however it was named', () => {
    const input = briefToAgentInput(brief({ tools: ['svc:gmail.fetch_emails', 'svc:gmail.fetch_emails'] }));
    expect(input.tools.filter((t) => t === 'svc:gmail.fetch_emails').length).toBe(1);
  });

  it('is still created switched OFF and on the worker road', () => {
    const input = briefToAgentInput(brief());
    expect(input.enabled).toBe(false);
    expect(input.useWorker).toBe(true);
    expect(input.origin).toBe('brief');
  });

  it('a brief with no tools of its own still works — reading is the common case', () => {
    expect(briefToAgentInput(brief({ tools: [] })).tools).toEqual(['svc:gmail.fetch_emails']);
    expect(briefToAgentInput(brief({ tools: undefined })).tools).toEqual(['svc:gmail.fetch_emails']);
  });

  it('drops junk rather than putting it on the job', () => {
    expect(briefToAgentInput(brief({ tools: ['', '  ', null, 'svc:notion.create_notion_page'] })).tools)
      .toEqual(['svc:notion.create_notion_page', 'svc:gmail.fetch_emails']);
  });
});

/**
 * The tools a brief names have to survive the whole way (BEA-1453).
 *
 * Third time in one night for this shape of bug: a field added on one side and not the other. The
 * brief could hold `tools`, the store could persist them, `briefToAgentInput` could put them on the
 * job — and the builder was never told the field existed, so a brief that described creating Notion
 * pages listed no Notion actions at all, and the worker would have had nothing to call.
 */
describe('the actions it writes with, from the model to the job', () => {
  const withTools = (tools: any) => readProposedBrief({
    name: 'n',
    sections: { want: [{ text: 'do it', origin: 'owner' }], success: [{ text: '5 emails', origin: 'owner' }] },
    sources: [{ actionId: 'svc:gmail.fetch_emails' }],
    tools,
    delivery: { whatsapp: true, messageText: 'hi <n>' },
  });

  it('reads them off the model\'s answer', () => {
    expect(withTools(['svc:notion.create_notion_page'])!.tools).toEqual(['svc:notion.create_notion_page']);
  });

  it('takes them however the model writes them', () => {
    expect(withTools([{ actionId: 'svc:notion.create_notion_page' }, { id: 'svc:whatsapp.send_text' }])!.tools)
      .toEqual(['svc:notion.create_notion_page', 'svc:whatsapp.send_text']);
  });

  it('is empty for a job that only reads, and that is fine', () => {
    expect(withTools(undefined)!.tools).toEqual([]);
    expect(withTools([])!.tools).toEqual([]);
  });

  it('drops junk and never repeats one', () => {
    expect(withTools(['', null, 'svc:a.b', 'svc:a.b'])!.tools).toEqual(['svc:a.b']);
  });

  it('the builder is TOLD the field exists, and that it is not optional', () => {
    // The bug was never the reading. It was that nothing asked the model to fill it in.
    expect(BRIEF_TEXT).toContain('"tools"');
    expect(BRIEF_TEXT).toContain('IS NOT OPTIONAL when it does anything but read');
    expect(BRIEF_TEXT).toContain('An action you do not list here, the agent cannot call');
  });
});

/**
 * A brief may not promise what an agent cannot do (BEA-1454).
 *
 * His first real brief named `search_brain` and `remember`. A worker can call neither. So it
 * promised *"recall the saved Master Page id, or save it"*, he read that, approved it, and the
 * machine could never have done it — a new Notion master page every night, for ever.
 *
 * The build did refuse it, four steps later, saying *"this job runs on the engine"* — which is not
 * even true of a brief-built agent. It belongs here, before he reads it.
 */
describe('the brief cannot promise the impossible', () => {
  const withTools = (tools: string[]) => readProposedBrief({
    name: 'n',
    sections: { want: [{ text: 'do it', origin: 'owner' }], success: [{ text: '5 emails', origin: 'owner' }] },
    sources: [{ actionId: 'svc:gmail.fetch_emails' }],
    tools,
    delivery: { whatsapp: true, messageText: 'hi <n>' },
  })!;
  const LOOKED = new Set(['svc:gmail.fetch_emails']);

  it('refuses the two his own brief named, and names them back', () => {
    const wrong = checkProposedBrief(withTools(['search_brain', 'remember']), LOOKED)!;
    expect(wrong.kind).toBe('cannot-do');
    expect(wrong.say).toContain('"search_brain"');
    expect(wrong.say).toContain('"remember"');
  });

  it('says what an agent CAN do, so it has somewhere to go', () => {
    const wrong = checkProposedBrief(withTools(['remember']), LOOKED)!;
    expect(wrong.say).toContain('cannot remember anything between runs');
    expect(wrong.say).toContain('look the thing up each time by its name');
  });

  it('allows every outside-service action, including the ones it writes with', () => {
    expect(checkProposedBrief(withTools(['svc:notion.create_notion_page', 'svc:whatsapp.send_text']), LOOKED)).toBeNull();
  });

  it('allows a brief with no tools at all — reading is the common case', () => {
    expect(checkProposedBrief(withTools([]), LOOKED)).toBeNull();
  });

  it('tells HIM what happened in his own terms, not in tool ids', () => {
    const said = briefHeldNote({ kind: 'cannot-do', say: '' });
    expect(said).toContain('cannot remember things between runs');
    expect(said).not.toContain('svc:');
    expect(said).toContain('another way round it');
  });

  it('the builder is told the limit up front, not only when it breaks one', () => {
    expect(BRIEF_TEXT).toContain('WHAT AN AGENT CAN ACTUALLY DO');
    expect(BRIEF_TEXT).toContain('CANNOT remember anything between runs');
    expect(BRIEF_TEXT).toContain('every id in "tools" must start with "svc:"');
  });
});

/**
 * When it runs has to leave the brief (BEA-1454, hole 2).
 *
 * He wrote **10PM** in his brief. It was in the brief, he would have approved it, and the code that
 * turns a brief into an agent did not carry a schedule at all — so it would have been created with
 * none, and a nightly digest would simply never have fired. The same silent drop as a message with
 * nowhere to live.
 */
describe('the schedule reaches the agent', () => {
  const brief = (schedule: any, when: string[] = ['10PM']) => ({
    name: 'n',
    sections: {
      want: [{ id: '1', text: 'do it', origin: 'owner' }],
      when: when.map((t, i) => ({ id: `w${i}`, text: t, origin: 'owner' })),
      filter: [], output: [], sources: [], success: [], trouble: [], killed: [],
    },
    sources: [{ id: 's', actionId: 'svc:gmail.fetch_emails', args: {} }],
    tools: [],
    schedule,
    delivery: { whatsapp: false, telegram: false, messageText: '' },
  }) as any;

  it('carries a nightly time onto the job, with his own words beside it', () => {
    const input = briefToAgentInput(brief({ every: 'day', at: '22:00' }));
    expect(input.schedule).toEqual({ every: 'day', at: '22:00' });
    expect(input.scheduleText).toBe('10PM');
  });

  it('carries the other three shapes the scheduler really fires', () => {
    expect(briefToAgentInput(brief({ every: 'weekday', at: '09:30' })).schedule).toEqual({ every: 'weekday', at: '09:30' });
    expect(briefToAgentInput(brief({ every: 'week', dow: 1, at: '08:00' })).schedule).toEqual({ every: 'week', dow: 1, at: '08:00' });
    expect(briefToAgentInput(brief({ every: 'hour', minute: 15 })).schedule).toEqual({ every: 'hour', minute: 15 });
  });

  it('drops a half-understood time rather than guessing at it', () => {
    // A schedule the scheduler cannot fire is worse than none: it looks set and never runs.
    for (const bad of [{ every: 'day', at: '10PM' }, { every: 'day' }, { every: 'week', at: '08:00' }, { every: 'fortnight', at: '08:00' }, null]) {
      expect(briefToAgentInput(brief(bad)).schedule).toBeUndefined();
    }
  });

  it('a job with no schedule is still made — it just waits for him to press Run', () => {
    const input = briefToAgentInput(brief(null, []));
    expect(input.schedule).toBeUndefined();
    expect(input.enabled).toBe(false);
  });

  it('the builder is told the exact shapes, because a wrong one never fires', () => {
    expect(BRIEF_TEXT).toContain('"schedule"');
    expect(BRIEF_TEXT).toContain('{"every":"week","dow":0-6,"at":"HH:MM"}');
    expect(BRIEF_TEXT).toContain('or it never fires');
  });
});
