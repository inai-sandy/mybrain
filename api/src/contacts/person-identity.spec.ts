import { matchContact, matchContactsAll, editDistance, contactSpellings, spellingsForName, similarity, norm } from './person-identity';

const C = [
  { id: 'c1', name: 'Vijaya Durga', aliases: ['Vijay', 'Vijay Durga'] },
  { id: 'c2', name: 'Srikar', aliases: [] as string[] },
];

describe('person-identity matcher (BEA-763)', () => {
  it('matches a contact by name OR any alias, case-insensitively', () => {
    expect(matchContact(C, 'Vijaya Durga')?.id).toBe('c1');
    expect(matchContact(C, 'vijay')?.id).toBe('c1'); // alias
    expect(matchContact(C, 'VIJAY DURGA')?.id).toBe('c1'); // alias, case
    expect(matchContact(C, 'Srikar')?.id).toBe('c2');
    expect(matchContact(C, 'Ravi')).toBeNull();
    expect(matchContact(C, '')).toBeNull();
  });

  it('contactSpellings returns name + aliases de-duped', () => {
    expect(contactSpellings(C[0])).toEqual(['Vijaya Durga', 'Vijay', 'Vijay Durga']);
    expect(contactSpellings({ id: 'x', name: 'A', aliases: ['a', 'A', 'B'] })).toEqual(['A', 'B']); // 'a'/'A' collapse
  });

  it('spellingsForName expands to the contact set, else just the name', () => {
    expect(spellingsForName(C, 'Vijay')).toEqual(['Vijaya Durga', 'Vijay', 'Vijay Durga']);
    expect(spellingsForName(C, 'Unknown Person')).toEqual(['Unknown Person']);
  });

  it('similarity flags likely same-person names, ignores unrelated', () => {
    expect(similarity('Vijaya Durga', 'Vijaya Durga')).toBe(1);
    expect(similarity('Vijaya Durga', 'Vijay')).toBeGreaterThanOrEqual(0.55); // containment / prefix
    expect(similarity('Vijaya Durga', 'Durga')).toBeGreaterThanOrEqual(0.55); // shared token / containment
    expect(similarity('Srikar', 'Ravi')).toBe(0);
    expect(similarity('Srikar', 'Srikanth')).toBeGreaterThanOrEqual(0.55); // strong first-name prefix
  });

  it('norm trims, lowercases, collapses spaces', () => {
    expect(norm('  Vijaya   Durga ')).toBe('vijaya durga');
  });
});

describe('fuzzy contact matching (BEA-949)', () => {
  const contacts = [{ id: '1', name: 'Srikar' }, { id: '2', name: 'Swathi' }];
  it('rescues a one-letter mishear: Shrikar -> Srikar', () => {
    expect(matchContactsAll(contacts, 'Shrikar').map((c) => c.name)).toEqual(['Srikar']);
  });
  it('exact matches still win', () => {
    expect(matchContactsAll(contacts, 'srikar').map((c) => c.name)).toEqual(['Srikar']);
  });
  it('does not match wildly different names', () => {
    expect(matchContactsAll(contacts, 'Dharmendra')).toEqual([]);
  });
  it('editDistance basics', () => {
    expect(editDistance('shrikar', 'srikar')).toBe(1);
  });
});
