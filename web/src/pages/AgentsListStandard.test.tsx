import { describe, it, expect } from 'vitest';

/**
 * The agents home meets the list standard, and cannot quietly drift below it (BEA-1528).
 *
 * The Agents Redesign plan said "agents home on the shared table". This screen is deliberately NOT on
 * `DataTable`, and that is a decision rather than an oversight — recorded here so the next person does
 * not "fix" it without knowing what it costs.
 *
 * WHY NOT. `DataTable` renders one `emptyText`. This screen needs two different empty states, and both
 * of them do something a string cannot:
 *   - an empty FOLDER says how to fill it and offers "Show all" (BEA-1380),
 *   - a search or filter that matched nothing offers "Clear".
 * It also carries multi-select bulk actions and a skeleton loader, neither of which `DataTable` models.
 * Converting would trade two working affordances and add risk on his most-used screen, in exchange for
 * component uniformity alone — every FUNCTION the standard asks for is already here.
 *
 * So the standard is enforced on the behaviour instead of the component. If any element below is
 * removed, this fails — which is the protection the shared component would otherwise have given.
 */
describe('the agents home meets the list standard (BEA-1528)', () => {
  const src = () => require('fs').readFileSync(__dirname + '/Agents.tsx', 'utf8');

  it('has a search box', () => {
    expect(src()).toContain('Search agents…');
  });

  it('has a filter, with the states worth filtering for', () => {
    const s = src();
    expect(s).toContain('aria-label="Filter agents"');
    for (const v of ['waiting', 'ran', 'never']) expect(s).toContain(`value="${v}"`);
  });

  it('has a sort, with more than one order', () => {
    const s = src();
    expect(s).toContain('aria-label="Sort agents"');
    for (const k of ['recent', 'name', 'jobs']) expect(s).toContain(`'${k}'`);
  });

  it('paginates through the shared table', () => {
    const s = src();
    expect(s).toMatch(/const PER = \d+/);
    expect(s).toContain('pageSize={PER}');
  });

  it('shows a total count', () => {
    expect(src()).toMatch(/agent\$\{|agent\{|agents?\$\{/);
  });

  // Both empty states survived the move to the shared table (BEA-1531), which is the whole point:
  // the folder case is answered BEFORE the table, and the way out of a narrowed list sits under it.
  it('has both empty states, each with a way out', () => {
    const s = src();
    expect(s).toContain('This folder is empty');
    expect(s).toContain('Show all');
    expect(s).toContain('Nothing matches');           // the table's emptyText
    expect(s).toContain('Clear search and filters');  // the way out, under the list
  });

  it('renders the list through the shared table', () => {
    const s = src();
    expect(s).toContain("import { DataTable }");
    expect(s).toContain('<DataTable<any>');
    expect(s).toContain('cardsOnly');
  });

  // controls mode is what lets this screen keep its own control bar AND get the table's paging.
  // Passing the kind tab as a filter is what makes a tab change reset to page one.
  it('hands its control values to the table, kind tab included', () => {
    const s = src();
    expect(s).toMatch(/controls=\{\{/);
    expect(s).toMatch(/kind: kindTab/);
    expect(s).toMatch(/status: agentFilter/);
  });

  it('has a loading state, not a blank screen', () => {
    expect(src()).toContain('animate-pulse');
  });

  it('has the four kind tabs', () => {
    const s = src();
    for (const k of ['all', 'tools', 'research', 'needs']) expect(s).toContain(`k: '${k}' as const`);
  });

  it('supports selecting several agents and acting on them at once', () => {
    const s = src();
    expect(s).toMatch(/bulkDelete|bulkEnabled/);
  });
});
