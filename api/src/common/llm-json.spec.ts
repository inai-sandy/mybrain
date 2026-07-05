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
