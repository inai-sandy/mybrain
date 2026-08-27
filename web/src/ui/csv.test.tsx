import { describe, expect, it } from 'vitest';
import { cell, csvName, toCsv } from './csv';

/**
 * EXPORT (BEA-1509).
 *
 * His CRUD standard asks for it and nothing had it. The escaping is the part that goes wrong quietly
 * — a title with a comma silently splits a row and nobody notices until the numbers are wrong.
 */
describe('one cell', () => {
  it('quotes anything a spreadsheet would misread', () => {
    expect(cell('Created ESP32-2026-08-27, sorted by score')).toBe('"Created ESP32-2026-08-27, sorted by score"');
    expect(cell('He said "keep it"')).toBe('"He said ""keep it"""');
    expect(cell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('quotes padding a spreadsheet would eat', () => {
    expect(cell('  leading')).toBe('"  leading"');
  });

  it('leaves plain text alone', () => {
    expect(cell('GitHub top 5')).toBe('GitHub top 5');
    expect(cell(90)).toBe('90');
  });

  it('writes nothing for nothing — "null" in a sheet is a lie about the data', () => {
    expect(cell(null)).toBe('');
    expect(cell(undefined)).toBe('');
    expect(cell('')).toBe('');
  });
});

describe('the whole file', () => {
  it('puts the header first and uses the line ending spreadsheets expect', () => {
    const csv = toCsv(['what', 'when'], [['GitHub top 5', '2026-08-27'], ['Sheet, with comma', '2026-08-26']]);
    expect(csv.split('\r\n')[0]).toBe('what,when');
    expect(csv).toContain('"Sheet, with comma"');
    expect(csv.split('\r\n')).toHaveLength(3);
  });

  it('still writes a header when there are no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b');
  });
});

describe('the filename', () => {
  it('sorts by date and drops anything a filesystem would argue with', () => {
    expect(csvName('ESP32 weekly top posts', new Date('2026-08-27T05:00:00Z'))).toBe('ESP32-weekly-top-posts-2026-08-27.csv');
    expect(csvName('Smart Home — India / 2026', new Date('2026-08-27T05:00:00Z'))).toBe('Smart-Home-India-2026-2026-08-27.csv');
  });

  it('never produces a nameless file', () => {
    expect(csvName('', new Date('2026-08-27T05:00:00Z'))).toBe('export-2026-08-27.csv');
    expect(csvName('——', new Date('2026-08-27T05:00:00Z'))).toBe('export-2026-08-27.csv');
  });
});
