import { keywords, rankActions, shortlistForPrompt } from './tool-shortlist';

/**
 * The prompt-sized slice (BEA-1354). The catalog holds every action; a prompt is shown the ones that
 * match the owner's words, with the vendor's mark as the tie-break, cut per service — and every
 * non-service tool untouched.
 */
describe('tool-shortlist', () => {
  const act = (id: string, name: string, description = '', important = false, service = 'github') => ({ id: `svc:${service}.${id}`, name, description, service, ...(important ? { important } : {}) });

  it('takes the meaningful words of a message, singular, without filler', () => {
    expect(keywords('Please star the repositories and list my issues')).toEqual(['star', 'repository', 'list', 'issue']);
    expect(keywords('')).toEqual([]);
  });

  it('ranks the actions that match what he said first, then the vendor’s most-used mark, then keeps their order', () => {
    const list = [
      act('accept_invite', 'Accept a repository invitation'),
      act('create_issue', 'Create an issue', 'Open an issue', true),
      act('list_stargazers', 'List stargazers', 'Who starred a repository'),
      act('star_repo', 'Star a repository', 'Star a repository for the authenticated user'),
      act('get_user', 'Get the authenticated user', '', true),
    ];
    const ranked = rankActions(list, 'star this repo for me').map((t) => t.id);
    expect(ranked[0]).toBe('svc:github.star_repo'); // "star" and "repo" both in the name
    expect(ranked.slice(0, 3)).toContain('svc:github.list_stargazers');
    // Nothing matches: the vendor's marks come first, in the order they came in.
    const cold = rankActions(list, 'hello there').map((t) => t.id);
    expect(cold.slice(0, 2)).toEqual(['svc:github.create_issue', 'svc:github.get_user']);
    expect(cold[2]).toBe('svc:github.accept_invite');
  });

  it('cuts each service to its best few and leaves every other tool exactly where it was', () => {
    const many = Array.from({ length: 800 }, (_, i) => act(`a${i}`, `Action ${i}`, i === 700 ? 'Delete a repository' : ''));
    const tools = [
      { id: 'search_brain', name: 'Search my brain', description: 'x' },
      ...many,
      { id: 'web_search', name: 'Web search', description: 'y' },
      act('send', 'Send an email', '', false, 'gmail'),
    ];
    const out = shortlistForPrompt(tools, 'delete the repository', 40);
    expect(out.slice(0, 2).map((t) => t.id)).toEqual(['search_brain', 'web_search']); // pass-through, in order
    expect(out.filter((t) => t.id.startsWith('svc:github.')).length).toBe(40);
    expect(out.filter((t) => t.id.startsWith('svc:gmail.')).length).toBe(1);
    expect(out[2].id).toBe('svc:github.a700'); // the one that matched is first of its service
    expect(out.length).toBe(43);
  });
});
