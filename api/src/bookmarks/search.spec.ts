import { BookmarksService } from './bookmarks.service';

// keywordScore + tokenize are pure; build a bare service and poke them. (BEA-613)
const svc = new BookmarksService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
const score = (it: any, q: string) => svc.keywordScore({ tags: [], ...it }, svc.tokenize(q));

describe('Bookmarks keyword search (BEA-613)', () => {
  it('ranks a title match above a summary-only match', () => {
    const titleHit = score({ title: 'Cloud SEO playbook' }, 'seo');
    const bodyHit = score({ title: 'Random', summary: 'a note that mentions seo once' }, 'seo');
    expect(titleHit).toBeGreaterThan(bodyHit);
    expect(bodyHit).toBeGreaterThan(0);
  });

  it('tolerates typos', () => {
    expect(score({ title: 'Pricing strategy' }, 'pricng')).toBeGreaterThan(0);
    expect(score({ title: 'Marketing roadmap', tags: ['seo'] }, 'marketng')).toBeGreaterThan(0);
  });

  it('requires all tokens on a short query', () => {
    expect(score({ title: 'Quarterly budget report' }, 'quarterly budget')).toBeGreaterThan(0);
    expect(score({ title: 'Quarterly budget report' }, 'quarterly zzzzz')).toBe(0);
  });

  it('matches tags and url too', () => {
    expect(score({ title: 'x', tags: ['hardware'] }, 'hardware')).toBeGreaterThan(0);
    expect(score({ title: 'x', sourceUrl: 'https://youtube.com/watch' }, 'youtube')).toBeGreaterThan(0);
  });
});
