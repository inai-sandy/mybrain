import { safeContainerTag } from './supermemory.store';

describe('safeContainerTag', () => {
  it('replaces spaces and special characters with hyphens', () => {
    expect(safeContainerTag('Second Brain')).toBe('second-brain');
    expect(safeContainerTag('flush test!')).toBe('flush-test');
    expect(safeContainerTag('delete verification')).toBe('delete-verification');
  });

  it('keeps allowed characters (a-z 0-9 _ : -)', () => {
    expect(safeContainerTag('a_b:c-1')).toBe('a_b:c-1');
  });
});
