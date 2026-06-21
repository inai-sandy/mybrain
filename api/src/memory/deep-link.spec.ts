import { deepLinkFor } from './memory.service';

// Shared source→route mapping used by both Explore and Chat (BEA-373). Lock the vault + common cases.
describe('deepLinkFor (source deep-links)', () => {
  it('vault items deep-link to the Vault with the item id', () => {
    expect(deepLinkFor({ type: 'vault', id: 'abc' })).toEqual({ link: '/vault?item=abc', sourceType: 'vault' });
  });
  it('maps the common app rows to their routes', () => {
    expect(deepLinkFor({ type: 'item', id: 'd1' })).toEqual({ link: '/doc/d1', sourceType: 'document' });
    expect(deepLinkFor({ type: 'idea', id: 'i1' })).toEqual({ link: '/ideas/i1', sourceType: 'idea' });
    expect(deepLinkFor({ type: 'meeting', id: 'm1' })).toEqual({ link: '/meeting/m1', sourceType: 'meeting' });
    expect(deepLinkFor({ type: 'task', id: 't1' })).toEqual({ link: '/tasks', sourceType: 'task' });
    expect(deepLinkFor({ type: 'note', id: 'n1' })).toEqual({ link: '/notes', sourceType: 'note' });
  });
  it('important emails link to the Gmail page', () => {
    expect(deepLinkFor({ type: 'email', id: 'e1' })).toEqual({ link: '/google/gmail', sourceType: 'email' });
  });
  it('story links to its day; unknown types fall back to Explore', () => {
    expect(deepLinkFor({ type: 'story', id: 's1', day: '2026-06-20' })).toEqual({ link: '/activity?day=2026-06-20', sourceType: 'story' });
    expect(deepLinkFor({ type: 'whatever', id: 'x' })).toEqual({ link: '/explore', sourceType: 'document' });
  });
});
