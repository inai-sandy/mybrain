import { parseMentions, resolveName, resolveMentions, linkableIds, exactMatches } from './mentions';

const CONTACTS = [
  { id: 'c1', name: 'Srikar', aliases: [] as string[] },
  { id: 'c2', name: 'Vijaya Durga', aliases: ['Vijay Durga'] },
  { id: 'c3', name: 'Preeti', aliases: ['Preethi', 'Wife'] },
  { id: 'c4', name: 'Dharmendra', aliases: [] as string[] },
  { id: 'c5', name: 'Dharmendra', aliases: [] as string[] }, // a genuine namesake
];

describe('parseMentions (BEA-1019)', () => {
  it('finds a plain @mention', () => {
    expect(parseMentions('Get the quote from @Srikar', CONTACTS)).toEqual(['Srikar']);
  });

  it('takes the LONGEST known spelling — a two-word name is one person', () => {
    expect(parseMentions('Send it to @Vijaya Durga today', CONTACTS)).toEqual(['Vijaya Durga']);
  });

  it('matches an alias spelling', () => {
    expect(parseMentions('ask @Vijay Durga', CONTACTS)).toEqual(['Vijay Durga']);
    expect(parseMentions('remind @Wife', CONTACTS)).toEqual(['Wife']);
  });

  it('does not swallow the following words when the name is one word', () => {
    expect(parseMentions('@Srikar needs the drawings', CONTACTS)).toEqual(['Srikar']);
  });

  it('finds several mentions in one sentence', () => {
    expect(parseMentions('@Srikar and @Preeti both', CONTACTS)).toEqual(['Srikar', 'Preeti']);
  });

  it('de-dupes the same person mentioned twice, whatever the case', () => {
    expect(parseMentions('@Srikar ... @srikar again', CONTACTS)).toEqual(['Srikar']);
  });

  it('still reports an unknown name so a typo can be shown, never silently dropped', () => {
    expect(parseMentions('chase @Rmesh about it', CONTACTS)).toEqual(['Rmesh']);
  });

  it('ignores an email address', () => {
    expect(parseMentions('mail sandy@gmail.com about it', CONTACTS)).toEqual([]);
  });

  it('stops a name at punctuation', () => {
    expect(parseMentions('tell @Srikar, then go', CONTACTS)).toEqual(['Srikar']);
  });

  it('returns nothing when there is no @ at all', () => {
    expect(parseMentions('Srikar needs the drawings', CONTACTS)).toEqual([]);
  });

  it('handles empty and missing text', () => {
    expect(parseMentions('', CONTACTS)).toEqual([]);
    expect(parseMentions(undefined as any, CONTACTS)).toEqual([]);
  });
});

describe('resolveName — never guesses (BEA-1019)', () => {
  it('resolves one clean match', () => {
    expect(resolveName(CONTACTS, 'Srikar')).toEqual({
      raw: 'Srikar', status: 'matched', contactId: 'c1', contactName: 'Srikar',
    });
  });

  it('resolves through an alias to the real contact', () => {
    const r = resolveName(CONTACTS, 'Preethi');
    expect(r).toMatchObject({ status: 'matched', contactId: 'c3', contactName: 'Preeti' });
  });

  it('reports ambiguity instead of picking one of two namesakes', () => {
    const r = resolveName(CONTACTS, 'Dharmendra');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.options.map((o) => o.id).sort()).toEqual(['c4', 'c5']);
  });

  it('reports unknown rather than fuzzy-matching a typo', () => {
    expect(resolveName(CONTACTS, 'Srikarr').status).toBe('unknown');
    expect(resolveName(CONTACTS, 'Shrikar').status).toBe('unknown');
  });

  it('is case- and space-insensitive on an exact name', () => {
    expect(resolveName(CONTACTS, '  sRiKaR ').status).toBe('matched');
  });
});

describe('resolveMentions + linkableIds (BEA-1019)', () => {
  it('links only the names that resolved cleanly', () => {
    const rs = resolveMentions('@Srikar @Rmesh @Dharmendra @Preethi', CONTACTS);
    expect(rs.map((r) => r.status)).toEqual(['matched', 'unknown', 'ambiguous', 'matched']);
    expect(linkableIds(rs)).toEqual(['c1', 'c3']); // the typo and the ambiguity link to nobody
  });

  it('never returns the same contact twice', () => {
    expect(linkableIds(resolveMentions('@Preeti and @Preethi', CONTACTS))).toEqual(['c3']);
  });
});

describe('exactMatches', () => {
  it('is exact only — no edit-distance rescue here', () => {
    expect(exactMatches(CONTACTS, 'Vijay Durga').map((c) => c.id)).toEqual(['c2']);
    expect(exactMatches(CONTACTS, 'Vijay')).toEqual([]);
  });
});
