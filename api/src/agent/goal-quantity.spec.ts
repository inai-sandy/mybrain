import { askedQuantity, feasibilityNote, quantityText } from './goal';

/**
 * The number a goal promises, checked against the world (BEA-1551).
 *
 * A quantity in a goal — "the top 100 posts" — is a promise about what exists, and nothing ever
 * checked it. Four of his fourteen failed runs were that promise meeting reality at RUNTIME, after a
 * worker had been built and promoted to chase it:
 *
 *     "I stopped before writing anything: The goal asks for 100 posts, but Reddit returned only 71"
 *
 * One real call answers it before he approves the goal.
 */
describe('askedQuantity — what did the goal promise?', () => {
  it('reads the plain forms', () => {
    expect(askedQuantity('the top 100 posts from r/esp32')).toBe(100);
    expect(askedQuantity('get 50 profiles each week')).toBe(50);
    expect(askedQuantity('the first 20 repos')).toBe(20);
  });

  // A wrong quantity puts a false warning in front of him, which is worse than none.
  it('says nothing when there is no promised count', () => {
    expect(askedQuantity('every ESP32 post this week')).toBeNull();
    expect(askedQuantity('a summary of my inbox')).toBeNull();
    expect(askedQuantity('')).toBeNull();
  });

  it('never mistakes a year for a count', () => {
    expect(askedQuantity('posts since 2024')).toBeNull();
  });

  it('ignores absurd numbers', () => {
    expect(askedQuantity('1 posts')).toBeNull();
  });
});

describe('feasibilityNote — is that number actually there?', () => {
  const look = (o: any) => ({ count: 0, ...o });

  // The strong case: provable from ONE call. No next page and fewer than asked = it does not exist.
  it('says plainly when the number does not exist', () => {
    const n = feasibilityNote(100, look({ count: 71, morePages: false }))!;
    expect(n).toContain('only 71');
    expect(n).toContain('do not exist right now');
    expect(n).toMatch(/promise what is really there/);
  });

  it('does the arithmetic when it needs paging', () => {
    const n = feasibilityNote(100, look({ count: 7, morePages: true }))!;
    expect(n).toContain('about 15 pages');
    // "more pages exist" is NOT "enough exist" — it must not over-promise either.
    expect(n).toContain('nothing has proved 100 exist');
  });

  it('says one fetch covers it when it does', () => {
    expect(feasibilityNote(5, look({ count: 12, morePages: true }))).toContain('One fetch covers it');
  });

  it('stays quiet when there is nothing to say', () => {
    expect(feasibilityNote(null, look({ count: 9 }))).toBeNull();
    expect(feasibilityNote(100, null)).toBeNull();
    expect(feasibilityNote(100, look({ count: 0, error: 'boom' }))).toBeNull();
  });
});

describe('what the goal prompt is told', () => {
  const req = (goal: string, look: any) => ({
    transcript: [{ who: 'you', text: goal }],
    tools: [{ actionId: 'svc:reddit.search', card: null, look }],
  }) as any;

  it('puts the check in the prompt when the goal names a number', () => {
    const t = quantityText(req('I want the top 100 posts each week', { count: 71, morePages: false }));
    expect(t).toContain('The number this goal promises');
    expect(t).toContain('only 71');
  });

  // He must not approve a number that cannot be delivered, and must not be surprised at the first run.
  it('tells Codex to say the truth in the goal he approves', () => {
    const t = quantityText(req('the top 100 posts', { count: 7, morePages: true }));
    expect(t).toMatch(/in the goal he approves/);
    expect(t).toMatch(/everything there is, however many that turns out to be/);
  });

  it('is silent when the goal promises no number', () => {
    expect(quantityText(req('every post about ESP32', { count: 7, morePages: true }))).toBe('');
  });

  it('is silent when no look could be taken', () => {
    expect(quantityText(req('the top 100 posts', undefined))).toBe('');
  });
});
