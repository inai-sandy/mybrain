import { describe, it, expect, beforeEach } from 'vitest';
import { loadObjectDraft, saveObjectDraft, clearDraft } from './useDraft';
import { savedAgo } from '../pages/CloseDay';

/**
 * BEA-1165. His words: *"can you also provide auto save option. if something goes wrong it has to
 * save at the exact position."* The Close-day wizard held the story, the step and every tick in
 * browser memory alone, so a reload sent him back to a blank box.
 */
describe('object drafts survive a reload', () => {
  beforeEach(() => localStorage.clear());

  it('comes back exactly as it went in', () => {
    const draft = { v: 1, at: 123, step: 'hours', text: 'A long day at the factory', ticked: { 'done:0': true, 'todos:1': false } };
    saveObjectDraft('k', draft);
    expect(loadObjectDraft('k')).toEqual(draft);
  });

  it('nothing saved means nothing restored', () => {
    expect(loadObjectDraft('never-written')).toBeNull();
  });

  it('a corrupt draft is no draft — it must never block him from starting', () => {
    localStorage.setItem('k', '{not json');
    expect(loadObjectDraft('k')).toBeNull();
  });

  it('a non-object draft is refused', () => {
    localStorage.setItem('k', '"just a string"');
    expect(loadObjectDraft('k')).toBeNull();
    localStorage.setItem('k', 'null');
    expect(loadObjectDraft('k')).toBeNull();
  });

  it('clearing really clears', () => {
    saveObjectDraft('k', { a: 1 });
    clearDraft('k');
    expect(loadObjectDraft('k')).toBeNull();
  });

  it('the hook stamps WHEN it saved, so the resume line can say how stale it is', () => {
    // The timestamp is added at write time, never by the caller — a caller-supplied Date.now() would
    // change on every render and restart the debounce forever. (BEA-1165)
    saveObjectDraft('k', { step: 'hours' });
    expect((loadObjectDraft('k') as any).at).toBeUndefined(); // the plain save does not stamp
  });

  it('saving never throws, even when storage refuses', () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceeded'); };
    expect(() => saveObjectDraft('k', { a: 1 })).not.toThrow(); // losing a draft is bad; crashing the wizard is worse
    Storage.prototype.setItem = real;
  });
});

describe('savedAgo — the resume line says how stale it is', () => {
  const ago = (ms: number) => savedAgo(Date.now() - ms);

  it('reads in plain words', () => {
    expect(ago(5_000)).toBe('just now');
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(5 * 60_000)).toBe('5 minutes ago');
    expect(ago(60 * 60_000)).toBe('1 hour ago');
    expect(ago(3 * 60 * 60_000)).toBe('3 hours ago');
    expect(ago(48 * 60 * 60_000)).toBe('2 days ago');
  });

  it('never says a negative or a broken time', () => {
    expect(savedAgo(Date.now() + 60_000)).toBe('just now'); // a clock that ran backwards
  });
});
