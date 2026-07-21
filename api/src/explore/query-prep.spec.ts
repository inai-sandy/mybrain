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

  describe('findPeople — alias + spelling aware', () => {
    const contacts = [
      { id: '1', name: 'Preeti', aliases: ['Preethi'] }, // the SAME person, both spellings
      { id: '2', name: 'Karthik', aliases: [] },
      { id: '3', name: 'Madhuri', aliases: [] },
    ];
    it('returns EVERY spelling of the person so both halves of their memories are searched', () => {
      const found = findPeople('How many times did I tell you I like preethi a lot?', contacts);
      expect(found.map((s) => s.toLowerCase()).sort()).toEqual(['preethi', 'preeti']);
    });
    it('works from either spelling', () => {
      expect(findPeople('what did preeti say', contacts).map((s) => s.toLowerCase()).sort()).toEqual(['preethi', 'preeti']);
    });
    it('matches a near-miss spelling even without an alias (voice/typing slips)', () => {
      const only = [{ id: '9', name: 'Srikar', aliases: [] }];
      expect(findPeople('did Shrikar reply', only)).toContain('Srikar');
    });
    it('finds more than one person', () => {
      const found = findPeople('Did Karthik and Madhuri meet?', contacts).sort();
      expect(found).toEqual(['Karthik', 'Madhuri']);
    });
    it('ignores ordinary words that are not names', () => {
      expect(findPeople('what did I do yesterday', contacts)).toEqual([]);
      expect(findPeople('how many times did I tell you that story', contacts)).toEqual([]);
    });
  });

  describe('buildSearchQuery', () => {
    it('keeps the person in the search text', () => {
      const q = buildSearchQuery('How many times did I tell you I like Preethi a lot?', ['Preethi']);
      expect(q).toBe('I like Preethi a lot');
    });
    it('adds the other spelling so both are searched', () => {
      const q = buildSearchQuery('How many times did I tell you I like Preethi a lot?', ['Preethi', 'Preeti']);
      expect(q).toContain('Preeti');
    });
  });
});
