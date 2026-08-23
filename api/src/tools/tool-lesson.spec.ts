import { describe, expect, it, beforeEach } from '@jest/globals';
import { NO_LESSON_SERVICES, cursorIn, cursorParamFor, lessonsFrom, listIn, shapeOf } from './tool-lesson';
import { LESSON_STALE_DAYS, ToolLessonService, learnedText, shapeInWords } from './tool-lesson.service';

/**
 * The app learns each tool by trying it (BEA-1409).
 *
 * His question: *"How does Codex know about all the tools we are using and the actions each tool
 * has?"* Two of the three sources were already automatic. The third was **me**, typing 35 notes by
 * hand against thousands of actions — and the Gmail note only got written AFTER it cost him a night.
 *
 * These tests are mostly one thing: **that exact bug, learned by the machine, with nobody typing.**
 */

const GMAIL = 'svc:gmail.fetch_emails';
const GMAIL_SCHEMA = {
  properties: {
    query: { type: 'string' },
    max_results: { type: 'number', default: 1, maximum: 500 },
    page_token: { type: 'string' },
  },
};

describe('the Gmail trap, learned without anybody typing a note', () => {
  it('spots that a count was left out and only one came back while there is more', () => {
    const out = lessonsFrom({
      actionId: GMAIL,
      service: 'gmail',
      args: { query: 'newer_than:1d' }, // no max_results — exactly what the builder did
      schema: GMAIL_SCHEMA,
      data: { messages: [{ id: 'm1' }], nextPageToken: 'abc' },
    });
    const silent = out.find((l) => l.kind === 'silent-default')!;
    expect(silent).toBeTruthy();
    expect(silent.param).toBe('max_results');
    expect(silent.text).toContain('was left out');
    expect(silent.text).toContain('another page');
    expect(silent.text).toContain('always set');
  });

  it('does NOT cry wolf when one really was all there was', () => {
    // No cursor: one row may honestly be the whole answer, and a lesson that fails a good run is
    // worse than no lesson at all.
    const out = lessonsFrom({ actionId: GMAIL, service: 'gmail', args: { query: 'x' }, schema: GMAIL_SCHEMA, data: { messages: [{ id: 'm1' }] } });
    expect(out.find((l) => l.kind === 'silent-default')).toBeUndefined();
  });

  it('says nothing about a count that WAS set', () => {
    const out = lessonsFrom({ actionId: GMAIL, service: 'gmail', args: { query: 'x', max_results: 50 }, schema: GMAIL_SCHEMA, data: { messages: [{ id: 'm1' }], nextPageToken: 'abc' } });
    expect(out.find((l) => l.kind === 'silent-default')).toBeUndefined();
  });

  it('learns from Gmail even though Gmail answers are never kept — which is the whole point', () => {
    // Gmail is in NO_SAMPLE_SERVICES on purpose: its answers carry message bodies. A lesson is
    // structure only, so it is safe here, and these are exactly the actions with no hand notes.
    const out = lessonsFrom({ actionId: GMAIL, service: 'gmail', args: {}, schema: GMAIL_SCHEMA, data: { messages: [{ id: 'm1' }], nextPageToken: 'abc' } });
    expect(out.length).toBeGreaterThan(0);
    // And nothing it wrote carries anybody's data.
    for (const l of out) expect(l.text).not.toContain('m1');
  });
});

describe('the other four things one call can teach', () => {
  it('how it pages, and how much a page holds', () => {
    const out = lessonsFrom({ actionId: 'svc:x.list', service: 'x', args: {}, schema: {}, data: { items: [1, 2, 3], next_cursor: 'c' } });
    const more = out.find((l) => l.kind === 'more-pages')!;
    expect(more.text).toContain('next_cursor');
    expect(more.text).toContain('one page held 3');
  });

  it('that a ceiling was hit', () => {
    const out = lessonsFrom({
      actionId: GMAIL,
      service: 'gmail',
      args: { max_results: 500 },
      schema: GMAIL_SCHEMA,
      data: { messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })) },
    });
    const cap = out.find((l) => l.kind === 'cap-hit')!;
    expect(cap.text).toContain('500 is the most');
  });

  it('that an argument was quietly dropped — the trap in CLAUDE.md, teaching itself', () => {
    const out = lessonsFrom({
      actionId: GMAIL,
      service: 'gmail',
      args: { query: 'x' },
      asked: { query: 'x', maxResults: 50 }, // the camelCase spelling this action does not take
      schema: GMAIL_SCHEMA,
      data: { messages: [{ id: 'm1' }, { id: 'm2' }] },
    });
    const dropped = out.find((l) => l.kind === 'ignored-argument')!;
    expect(dropped.param).toBe('maxResults');
    expect(dropped.text).toContain('was dropped');
  });

  it('that a "search" answers with one object — the BEA-1377 shape', () => {
    const out = lessonsFrom({ actionId: 'svc:instagram.search_profile', service: 'instagram', args: {}, schema: {}, data: { user: { name: 'x' } } });
    expect(out.find((l) => l.kind === 'single-object')).toBeTruthy();
  });

  it('learns nothing at all from a vault', () => {
    expect(NO_LESSON_SERVICES.has('vault')).toBe(true);
    expect(lessonsFrom({ actionId: 'svc:vault.read', service: 'vault', args: {}, schema: GMAIL_SCHEMA, data: { items: [1], next: 'c' } })).toEqual([]);
  });
});

describe('finding the list and the "there is more" marker', () => {
  it('reads a bare array, a named list, and one level inside a wrapper', () => {
    expect(listIn([1, 2])!.items.length).toBe(2);
    expect(listIn({ messages: [1] })!.key).toBe('messages');
    expect(listIn({ success: true, data: { items: [1, 2, 3] } })!.key).toBe('data.items');
  });

  it('names the cursor without ever reading its value', () => {
    expect(cursorIn({ nextPageToken: 'secret-token' })).toBe('nextPageToken');
    expect(cursorIn({ paging: { cursor: 'secret' } })).toBe('paging.cursor');
    expect(cursorIn({ nextPageToken: '' })).toBe('');
    expect(cursorIn({ nothing: 1 })).toBe('');
  });
});

// ---- the store ------------------------------------------------------------------------------------

function store() {
  const rows: any[] = [];
  return {
    rows,
    prisma: {
      toolLesson: {
        upsert: async ({ where, create, update }: any) => {
          const found = rows.find((r) => r.actionId === where.actionId_key.actionId && r.key === where.actionId_key.key);
          if (!found) { rows.push({ id: `l${rows.length + 1}`, timesSeen: 1, lastConfirmedAt: new Date(), createdAt: new Date(), ...create }); return rows[rows.length - 1]; }
          Object.assign(found, { ...update, timesSeen: found.timesSeen + (update.timesSeen?.increment || 0), lastConfirmedAt: update.lastConfirmedAt || found.lastConfirmedAt });
          return found;
        },
        findMany: async ({ where }: any) => rows.filter((r) => (where.actionId?.in ? where.actionId.in.includes(r.actionId) : r.actionId === where.actionId)),
        deleteMany: async ({ where }: any) => { const n = rows.length; for (let i = rows.length - 1; i >= 0; i--) if (rows[i].actionId === where.actionId) rows.splice(i, 1); return { count: n - rows.length }; },
      },
    } as any,
  };
}

describe('what the notebook does with them', () => {
  let s: ReturnType<typeof store>;
  let svc: ToolLessonService;
  beforeEach(() => { s = store(); svc = new ToolLessonService(s.prisma); });

  const teach = () => svc.learn({ actionId: GMAIL, service: 'gmail', args: {}, schema: GMAIL_SCHEMA, data: { messages: [{ id: 'm1' }], nextPageToken: 'abc' }, callId: 'tc1' });

  it('writes a lesson with the call that proves it', async () => {
    await teach();
    const facts = await svc.forAction(GMAIL);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].callId).toBe('tc1');
  });

  it('seeing the same thing again counts it, and never makes a second row', async () => {
    await teach();
    await teach();
    await teach();
    const facts = await svc.forAction(GMAIL);
    const silent = facts.find((f) => f.kind === 'silent-default')!;
    expect(silent.timesSeen).toBe(3);
    expect(facts.filter((f) => f.kind === 'silent-default').length).toBe(1);
  });

  it('a fact seen once says so; seen again it is confirmed', async () => {
    await teach();
    expect((await svc.forAction(GMAIL))[0].confidence).toBe('seen once');
    await teach();
    expect((await svc.forAction(GMAIL)).find((f) => f.kind === 'silent-default')!.confidence).toBe('confirmed');
  });

  it('a fact nobody has confirmed for a month is marked ageing, not quietly kept as true', async () => {
    await teach();
    const later = Date.now() + (LESSON_STALE_DAYS + 1) * 86_400_000;
    expect((await svc.forAction(GMAIL, later))[0].confidence).toBe('ageing');
  });

  it('a store that cannot be written does not break the call it learned from', async () => {
    const broken = new ToolLessonService({ toolLesson: { upsert: async () => { throw new Error('disk full'); } } } as any);
    await expect(broken.learn({ actionId: GMAIL, service: 'gmail', args: {}, schema: GMAIL_SCHEMA, data: { messages: [{ id: 'm' }], nextPageToken: 'a' } })).resolves.toBeTruthy();
  });

  it('reads a whole shortlist at once, for the builder and the build brief', async () => {
    await teach();
    await svc.learn({ actionId: 'svc:x.list', service: 'x', args: {}, schema: {}, data: { items: [1], cursor: 'c' } });
    const map = await svc.forActions([GMAIL, 'svc:x.list', 'svc:never.used']);
    expect(Object.keys(map).sort()).toEqual([GMAIL, 'svc:x.list'].sort());
  });

  it('writes the learned half of a card in plain words', async () => {
    await teach();
    await teach();
    const text = learnedText(await svc.forAction(GMAIL));
    expect(text).toContain('What using it has taught us');
    expect(text).toContain('learned by using it');
    expect(text).toContain('seen 2 times');
  });

  it('an action nobody has used has nothing to say, and does not pretend otherwise', async () => {
    expect(await svc.forAction('svc:never.used')).toEqual([]);
    expect(learnedText([])).toBe('');
  });
});

/**
 * Paging follows what we LEARNED, not what the app guesses (BEA-1415).
 *
 * The second of the two places a brand-new tool could still hurt him. The app infers a cursor's name
 * from a list of shapes it has met; a tool nobody has used is not on that list. Since BEA-1409 the
 * first real call writes the cursor's name down, so there is nothing left to guess.
 */
describe('the cursor we learned is the cursor we send back', () => {
  it('records the cursor name where a machine can read it, not only in a sentence', () => {
    const out = lessonsFrom({ actionId: 'svc:x.list', service: 'x', args: {}, schema: {}, data: { items: [1], nextPageToken: 'abc' } });
    const more = out.find((l) => l.kind === 'more-pages')!;
    expect(more.param).toBe('nextPageToken');
    // The NAME only. Never the value.
    expect(JSON.stringify(more)).not.toContain('abc');
  });

  it('maps an answer field to the argument it goes back in — they are rarely the same word', () => {
    expect(cursorParamFor('nextPageToken')).toBe('page_token');
    expect(cursorParamFor('next_max_id')).toBe('next_max_id');
    expect(cursorParamFor('paging.cursor')).toBe('cursor');
    expect(cursorParamFor('next_page_id')).toBe('next_page_id');
    expect(cursorParamFor('anything_else')).toBe('cursor');
  });

  it('is the SAME mapping the app already used for its guess', async () => {
    // One mapping in one place, or the learned cursor and the guessed one drift apart and a tool
    // pages correctly on its first run and wrongly on its second.
    const { pagingOf } = await import('../social/plan');
    expect(pagingOf(null, {}, { nextPageToken: 'x' })!.param).toBe(cursorParamFor('nextPageToken'));
  });
});

/**
 * The learned SHAPE — what fills the hole the first recipe attempt left (BEA-1415).
 *
 * A reading recipe is written from a saved answer. Gmail, WhatsApp and Slack answers are
 * **deliberately never saved**, because they carry people's messages — and those are precisely the
 * services whose shapes the app's general reader is worst at. So the first version of the recipe
 * work helped the tools that did not need it and could not help the one that started all of this.
 *
 * A shape is paths and types. No values. That is why it can exist for Gmail.
 */
describe('the shape of an answer, learned without keeping the answer', () => {
  const GMAIL = {
    messages: [
      { id: 'm1', internalDate: '1755900000000', payload: { headers: [{ name: 'Subject', value: 'A quote for you' }, { name: 'From', value: 'ravi@x.com' }] } },
      { id: 'm2', internalDate: '1755900100000', payload: { headers: [{ name: 'To', value: 'sandy@kiot.io' }] } },
    ],
    nextPageToken: 'abc',
  };

  it('writes down where the things are and what they carry', () => {
    const shape = shapeOf(GMAIL)!;
    expect(shape.listPath).toBe('messages');
    expect(shape.items).toBe(2);
    const paths = shape.fields.map((f) => f.path);
    expect(paths).toContain('id');
    expect(paths).toContain('internalDate');
  });

  it('reaches a header BY NAME — the shape half the world uses, and the one the app reads worst', () => {
    const paths = shapeOf(GMAIL)!.fields.map((f) => f.path);
    expect(paths).toContain('payload.headers.Subject');
    expect(paths).toContain('payload.headers.From');
    // `payload.headers.0.value` is exactly the useless column the general reader already produces.
    expect(paths).not.toContain('payload.headers.0.value');
  });

  it('looks at several items, so a field missing from the first is not lost', () => {
    // `To` is only on the second message. A shape written from item 1 alone would drop the column.
    expect(shapeOf(GMAIL)!.fields.map((f) => f.path)).toContain('payload.headers.To');
  });

  it('carries NO values — not a subject, not an address, nothing', () => {
    const json = JSON.stringify(shapeOf(GMAIL));
    expect(json).not.toContain('A quote for you');
    expect(json).not.toContain('ravi@x.com');
    expect(json).not.toContain('sandy@kiot.io');
    expect(json).not.toContain('abc');
  });

  it('drops a path segment that is itself a value', () => {
    const keyedByPerson = { items: [{ 'ravi@x.com': { seen: true }, '918888888888': 1, ok: 2 }] };
    const paths = shapeOf(keyedByPerson)!.fields.map((f) => f.path);
    expect(paths).toContain('ok');
    expect(paths.join(' ')).not.toContain('ravi@x.com');
    expect(paths.join(' ')).not.toContain('918888888888');
  });

  it('handles a single-record answer', () => {
    const shape = shapeOf({ username: 'kiot', followers: 900 })!;
    expect(shape.listPath).toBe('');
    expect(shape.items).toBe(1);
    expect(shape.fields.map((f) => f.path)).toEqual(['username', 'followers']);
  });

  it('rides along as a lesson, so it is learned from every real call', () => {
    const out = lessonsFrom({ actionId: 'svc:gmail.fetch_emails', service: 'gmail', args: {}, schema: {}, data: GMAIL });
    const shape = out.find((l) => l.kind === 'shape')!;
    expect(shape.shape!.listPath).toBe('messages');
    expect(shape.text).toContain('messages');
    expect(shape.text).not.toContain('ravi@x.com');
  });

  it('still learns nothing at all from a vault', () => {
    expect(lessonsFrom({ actionId: 'svc:vault.read', service: 'vault', args: {}, schema: {}, data: GMAIL })).toEqual([]);
  });

  it('is written for Codex as paths he can check, and says so', () => {
    const words = shapeInWords('svc:gmail.fetch_emails', shapeOf(GMAIL)!);
    expect(words).toContain('svc:gmail.fetch_emails');
    expect(words).toContain('`payload.headers.Subject`');
    expect(words).toContain('a path not on this list will be refused');
  });
});
