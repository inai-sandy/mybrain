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

  it('paginates, and says which page you are on', () => {
    const s = src();
    expect(s).toMatch(/const PER = \d+/);
    expect(s).toContain('Page {page} of {pages}');
  });

  it('shows a total count', () => {
    expect(src()).toMatch(/agent\$\{|agent\{|agents?\$\{/);
  });

  // The two empty states are the whole reason this screen is not on DataTable. If either goes, the
  // justification goes with it — and then it SHOULD be converted.
  it('has both empty states, each with a way out', () => {
    const s = src();
    expect(s).toContain('This folder is empty');
    expect(s).toContain('Show all');
    expect(s).toContain('Nothing matches');
    expect(s).toContain('>Clear<');
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
