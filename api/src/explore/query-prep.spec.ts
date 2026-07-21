import { stripMeta, findPeople, buildSearchQuery } from './query-prep';

describe('query-prep — understand the question before searching (BEA-1011)', () => {
  describe('stripMeta', () => {
    it("removes 'how many times did I tell you' — the real failing question", () => {
      expect(stripMeta('How many times did I tell you I like Preethi a lot?')).toBe('I like Preethi a lot');
    });
    it('removes other asking-wrappers', () => {
      expect(stripMeta('Do you remember I met Karthik last week?')).toBe('I met Karthik last week');
      expect(stripMeta('Did I ever say that the Haasya visit went well?')).toBe('the Haasya visit went well');
      expect(stripMeta('Tell me about the power module')).toBe('the power module');
    });
    it('handles stacked wrappers from real speech', () => {
      expect(stripMeta('So, do you remember, did I tell you I like Preethi a lot?')).toBe('I like Preethi a lot');
    });
    it('leaves a normal question alone', () => {
      expect(stripMeta('What did Preethi say about the school fees')).toContain('Preethi');
    });
    it('never returns empty — falls back to the original', () => {
      expect(stripMeta('do you remember?')).toBeTruthy();
    });
  });

  describe('findPeople', () => {
    const known = ['Preethi', 'Karthik', 'Madhuri', 'Raja'];
    it('finds the person a question is about, case-insensitively', () => {
      expect(findPeople('How many times did I tell you I like preethi a lot?', known)).toEqual(['Preethi']);
    });
    it('finds more than one', () => {
      expect(findPeople('Did Karthik and Madhuri meet?', known).sort()).toEqual(['Karthik', 'Madhuri']);
    });
    it('does not match a substring of another word', () => {
      expect(findPeople('I bought a raja-style lamp', known)).toEqual(['Raja']); // word-boundary hit is fine
      expect(findPeople('the projector needs fixing', known)).toEqual([]);
    });
    it('returns nothing when no known person is mentioned', () => {
      expect(findPeople('what did I do yesterday', known)).toEqual([]);
    });
  });

  describe('buildSearchQuery', () => {
    it('keeps the person in the search text', () => {
      const q = buildSearchQuery('How many times did I tell you I like Preethi a lot?', ['Preethi']);
      expect(q).toBe('I like Preethi a lot');
    });
    it('adds the person when stripping removed them', () => {
      const q = buildSearchQuery('Do you remember her birthday?', ['Preethi']);
      expect(q).toContain('Preethi');
    });
  });
});
