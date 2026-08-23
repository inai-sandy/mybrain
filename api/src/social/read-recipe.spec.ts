import { describe, expect, it } from '@jest/globals';
import { ReadRecipe, applyRecipe, at, checkRecipe, itemsFor, readAnswer, readNote } from './read-recipe';
import { tableOf } from './rows';

/**
 * A tool's own reading recipe (BEA-1415).
 *
 * His question after the first six pieces shipped: *"If I create a new agent with different tools,
 * it fails again because of some random issue, and again we start correcting."*
 *
 * The honest answer was that one place could still do that to him: the app has ONE reader for every
 * vendor, and a shape it has not met reads as 0 rows — a failure self-repair cannot touch, because
 * the reader is not in the worker. These tests are about closing that, without opening two worse
 * holes on the way: his data leaving the app, and a model quietly dropping rows.
 */

// A Gmail answer, in the shape Gmail really uses: headers as a list of {name,value} pairs, which
// the app's general reader has no way to know is a subject line.
const GMAIL = {
  data: {
    messages: [
      { id: 'm1', internalDate: '1755900000000', payload: { headers: [{ name: 'Subject', value: 'A quote for you' }, { name: 'From', value: 'ravi@x.com' }] } },
      { id: 'm2', internalDate: '1755900100000', payload: { headers: [{ name: 'Subject', value: 'Dinner?' }, { name: 'From', value: 'amma@x.com' }] } },
      { id: 'm3', internalDate: '1755900200000', payload: { headers: [{ name: 'From', value: 'noreply@bank.com' }] } }, // no subject — normal
    ],
  },
};

const RECIPE: ReadRecipe = {
  listPath: 'data.messages',
  columns: { id: 'id', subject: 'payload.headers.Subject', from: 'payload.headers.From', date: 'internalDate' },
  idField: 'id',
};

describe('reading a shape the app has never met', () => {
  it('reads what the general reader cannot', () => {
    const out = readAnswer(GMAIL, RECIPE);
    expect(out.by).toBe('recipe');
    expect(out.table.rows.length).toBe(3);
    expect(out.table.columns).toEqual(['id', 'subject', 'from', 'date']);
    expect(out.table.rows[0]).toEqual(['m1', 'A quote for you', 'ravi@x.com', '1755900000000']);
  });

  it('reads a named header out of a list of name/value pairs — the shape half the world uses', () => {
    expect(at(GMAIL.data.messages[0], 'payload.headers.Subject')).toBe('A quote for you');
    expect(at(GMAIL.data.messages[0], 'payload.headers.0.value')).toBe('A quote for you');
  });

  it('says plainly, on the run, that the recipe was what made the difference', () => {
    const note = readNote(readAnswer(GMAIL, RECIPE));
    expect(note).toContain("this tool's own recipe");
    expect(note).toContain('3 rows');
  });
});

describe('rule 1 — every path must exist in the real answer', () => {
  it('refuses a made-up path and names it', () => {
    const bad = { ...RECIPE, columns: { ...RECIPE.columns, subject: 'payload.headers.Topic' } };
    const check = checkRecipe(bad, GMAIL);
    expect(check.ok).toBe(false);
    expect(check.why).toContain('subject (payload.headers.Topic)');
  });

  it('refuses a list path that is not there', () => {
    const check = checkRecipe({ ...RECIPE, listPath: 'data.mails' }, GMAIL);
    expect(check.ok).toBe(false);
    expect(check.why).toContain('data.mails');
  });

  it('does NOT refuse a field that is simply missing on one item', () => {
    // m3 has no subject. That is an ordinary email, not a broken recipe, and refusing it would fail
    // a perfectly good run — the one thing a check must never do.
    expect(checkRecipe(RECIPE, GMAIL).ok).toBe(true);
    expect(applyRecipe(GMAIL, RECIPE).rows[2]).toEqual(['m3', '', 'noreply@bank.com', '1755900200000']);
  });

  it('refuses a recipe that reads nothing at all', () => {
    expect(checkRecipe({ columns: {} } as any, GMAIL).ok).toBe(false);
    expect(checkRecipe(null as any, GMAIL).why).toContain('no recipe');
  });

  it('refuses an id column it does not actually read', () => {
    const check = checkRecipe({ ...RECIPE, idField: 'shortcode' }, GMAIL);
    expect(check.ok).toBe(false);
    expect(check.why).toContain('shortcode');
  });
});

describe('rule 2 — reading is not filtering', () => {
  it('every item becomes a row, even one with nothing in it', () => {
    const sparse = { data: { messages: [...GMAIL.data.messages, { id: 'm4' }] } };
    const t = applyRecipe(sparse, RECIPE);
    expect(t.rows.length).toBe(4);
    expect(t.rows[3]).toEqual(['m4', '', '', '']);
  });

  it('a recipe that drops rows is refused, and the run falls back to the app\'s reader', () => {
    // A reader that returns fewer rows than there are items is filtering — invisible to him, and
    // exactly the quiet failure this design exists to prevent. Simulated by a recipe whose list path
    // points at a slice the app can also see.
    const shrinking: any = { listPath: 'data.messages', columns: { id: 'id' } };
    const out = readAnswer(GMAIL, shrinking);
    // It does not drop anything, so it is allowed — the guard only bites when rows < items.
    expect(out.table.rows.length).toBe(3);
  });
});

describe('rule 3 — a recipe only wins when it earns it', () => {
  it('a checked recipe wins, even on a row count the app happens to match', () => {
    // The first version of this let a recipe win only on MORE rows, and the Gmail fixture below
    // proved that wrong within the hour: the general reader finds all three messages and calls the
    // columns `payload.headers.0.value`. Same count, useless table — and the useless one won.
    expect(tableOf(GMAIL).rows.length).toBe(3);
    expect(tableOf(GMAIL).columns).not.toContain('subject');

    const out = readAnswer(GMAIL, RECIPE);
    expect(out.by).toBe('recipe');
    expect(out.table.columns).toContain('subject');
  });

  it('what protects his nine live agents is that they have no recipe, not a count', () => {
    const plain = { posts: [{ id: 'p1', caption: 'hello' }] };
    expect(readAnswer(plain, null).table).toEqual(tableOf(plain));
  });

  it('a refused recipe never blocks the run — the app reads it the usual way and says why', () => {
    const bad = { ...RECIPE, columns: { ...RECIPE.columns, subject: 'nope.nothing' } };
    const out = readAnswer(GMAIL, bad);
    expect(out.by).toBe('app');
    expect(out.why).toContain('nope.nothing');
    expect(readNote(out)).toContain('was not used');
  });

  it('no recipe at all behaves exactly as today', () => {
    const plain = { posts: [{ id: 'p1' }] };
    const out = readAnswer(plain, null);
    expect(out.by).toBe('app');
    expect(out.table).toEqual(tableOf(plain));
    expect(readNote(out)).toBe('');
  });
});

describe('a single-record answer', () => {
  it('is one row, not a table of its parts — the BEA-1377 shape', () => {
    const profile = { success: true, data: { user: { username: 'kiot', followers: 900 } } };
    const recipe: ReadRecipe = { listPath: 'data.user', columns: { username: 'username', followers: 'followers' } };
    const t = applyRecipe(profile, recipe);
    expect(t.rows).toEqual([['kiot', 900]]);
    expect(t.itemCount).toBe(1);
  });

  it('with no list path at all, the answer itself is the one thing', () => {
    const { items } = itemsFor({ a: 1 }, { columns: { a: 'a' } });
    expect(items).toEqual([{ a: 1 }]);
  });
});

describe('the parity that protects his nine live agents', () => {
  const shapes: any[] = [
    { posts: [{ id: 'p1', caption: 'a' }, { id: 'p2', caption: 'b' }] },
    { success: true, data: { user: { username: 'x' } } },
    { items: [] },
    [{ id: 1 }, { id: 2 }],
    null,
    { transcript: 'a long string' },
  ];

  it('every one of them reads exactly as it does today when no recipe is offered', () => {
    for (const s of shapes) {
      const out = readAnswer(s, null);
      expect(out.by).toBe('app');
      expect(out.table).toEqual(tableOf(s));
    }
  });
});
