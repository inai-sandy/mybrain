import { looseJsonParse, narrativeField, looksLikeRawJsonBlob } from './llm-json';

describe('looseJsonParse (BEA-884)', () => {
  it('parses clean JSON', () => {
    expect(looseJsonParse('{"guidance":"hello","adherenceScore":80}')).toEqual({ guidance: 'hello', adherenceScore: 80 });
  });

  it('repairs RAW (unescaped) newlines inside a string value — the actual bug', () => {
    const raw = '{"adherenceScore": 80, "guidance": "Line one.\nLine two.\nLine three."}';
    const j = looseJsonParse(raw);
    expect(j.adherenceScore).toBe(80);
    expect(j.guidance).toBe('Line one.\nLine two.\nLine three.');
  });

  it('strips ```json fences and surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{"title":"A Day","story":"It was fine."}\n```';
    expect(looseJsonParse(raw)).toEqual({ title: 'A Day', story: 'It was fine.' });
  });

  it('returns null on truly non-JSON', () => {
    expect(looseJsonParse('just some prose, no braces')).toBeNull();
    expect(looseJsonParse('')).toBeNull();
  });
});

describe('narrativeField (BEA-884)', () => {
  it('pulls the field out of JSON', () => {
    expect(narrativeField('{"adherenceScore":80,"guidance":"Do the thing."}', 'guidance')).toBe('Do the thing.');
  });

  it('pulls a multi-line field even when JSON.parse would choke', () => {
    const raw = '{"adherenceScore": 80, "guidance": "First.\nSecond."}';
    expect(narrativeField(raw, 'guidance')).toBe('First.\nSecond.');
  });

  it('returns plain prose unchanged (no JSON)', () => {
    expect(narrativeField('You had a strong day.', 'guidance')).toBe('You had a strong day.');
  });

  it('NEVER returns a visible {...} blob — the whole point', () => {
    // an unparseable JSON-looking blob → empty, not braces
    const broken = '{"guidance": "unterminated string ...';
    const out = narrativeField(broken, 'guidance');
    expect(out.startsWith('{')).toBe(false);
  });
});

describe('looksLikeRawJsonBlob (backfill detector)', () => {
  it('flags a stored raw JSON blob', () => {
    expect(looksLikeRawJsonBlob('{"adherenceScore":80,"guidance":"x"}')).toBe(true);
    expect(looksLikeRawJsonBlob('```json\n{"a":"b"}\n```')).toBe(true);
  });
  it('does not flag normal prose', () => {
    expect(looksLikeRawJsonBlob('You had a good day, and it showed.')).toBe(false);
    expect(looksLikeRawJsonBlob('')).toBe(false);
  });
});

/**
 * BEA-1163. On 28 July the owner's day-close deep read failed three times. The log shows why: the
 * reply hit its 2500-token ceiling and was cut off mid-JSON, so the parser returned null and a
 * reply containing most of his day was thrown away because the LAST item was incomplete.
 */
describe('a reply cut off at the token ceiling (BEA-1163)', () => {
  it('keeps every complete item when the last one is unfinished', () => {
    const cut = '{"done":[{"title":"Called the CA"},{"title":"Sent the sheet"},{"title":"Half a th';
    const r = looseJsonParse(cut);
    expect(r).toBeTruthy();
    expect(r.done.map((d: any) => d.title)).toEqual(['Called the CA', 'Sent the sheet']);
  });

  it('keeps earlier sections when it runs out partway through a later one', () => {
    const cut = '{"done":[{"title":"A"}],"todos":[{"title":"B"}],"emotions":{"feeling":"tir';
    const r = looseJsonParse(cut);
    expect(r.done[0].title).toBe('A');
    expect(r.todos[0].title).toBe('B');
  });

  it('is not fooled by a brace inside their own words', () => {
    const cut = '{"done":[{"title":"Fixed the {weird} label"},{"title":"cut off he';
    const r = looseJsonParse(cut);
    expect(r.done).toHaveLength(1);
    expect(r.done[0].title).toBe('Fixed the {weird} label');
  });

  it('returns nothing when nothing complete survived — never invents an item', () => {
    expect(looseJsonParse('{"done":[{"title":"only a fragm')).toBeNull();
    expect(looseJsonParse('{"do')).toBeNull();
  });

  it('a whole reply is still parsed normally, untouched', () => {
    const ok = '{"done":[{"title":"A"}],"todos":[]}';
    expect(looseJsonParse(ok)).toEqual({ done: [{ title: 'A' }], todos: [] });
  });

  it('still repairs raw newlines inside a value, as before', () => {
    const messy = '{"summary":"line one\nline two"}';
    expect(looseJsonParse(messy).summary).toBe('line one\nline two');
  });
});
