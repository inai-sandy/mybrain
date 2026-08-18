import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RetiredTag, ServiceFolds, groupByService, liveFirst, splitName } from './ServiceFolds';

/**
 * Every action of every connected service is in the catalog now (BEA-1354). The pickers must stay
 * usable with ~800 GitHub actions on a phone: folded per service, search WITHIN a service, and a
 * page at a time — never hundreds of buttons at once.
 */
const many = Array.from({ length: 781 }, (_, i) => ({
  id: `svc:github.action_${i}`,
  name: `GitHub: Action ${i}`,
  description: i === 500 ? 'Star a repository for the authenticated user' : `Does thing ${i}`,
  service: 'github',
}));
const gmail = [{ id: 'svc:gmail.send_email', name: 'Gmail: Send email', description: 'Send one', service: 'gmail' }];

const draw = (query = '') =>
  render(<ServiceFolds items={[...many, ...gmail]} query={query} pickedIds={['svc:github.action_3']} renderItem={(t, label) => <button key={t.id}>{label}</button>} />);

describe('ServiceFolds', () => {
  it('splits "Service: action" and groups by service in first-seen order', () => {
    expect(splitName('GitHub: Create an issue')).toEqual({ service: 'GitHub', label: 'Create an issue' });
    expect(groupByService([...many, ...gmail]).map((g) => [g.title, g.items.length])).toEqual([['GitHub', 781], ['Gmail', 1]]);
  });

  it('starts folded — the counts show, the 781 rows do not', () => {
    draw();
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.getByText(/781 actions/)).toBeTruthy();
    expect(screen.getByText(/1 picked/)).toBeTruthy();
    expect(screen.queryByText('Action 0')).toBeNull();
    expect(screen.queryAllByRole('button').length).toBeLessThan(5); // two fold headers, nothing else
  });

  it('opens to one page with a search-within-service box, and never renders all 781 at once', () => {
    draw();
    fireEvent.click(screen.getByText('GitHub'));
    expect(screen.getByText('Action 0')).toBeTruthy();
    expect(screen.getByText('Action 39')).toBeTruthy();
    expect(screen.queryByText('Action 40')).toBeNull();
    expect(screen.getByText(/Show 40 more · 741 left/)).toBeTruthy();
    // Search inside GitHub only — the 781 become the one that matches, by description.
    fireEvent.change(screen.getByLabelText("Search GitHub's actions"), { target: { value: 'star repository' } });
    expect(screen.getByText('Action 500')).toBeTruthy();
    expect(screen.queryByText('Action 0')).toBeNull();
    expect(screen.queryByText(/Show 40 more/)).toBeNull();
    // Paging is per page, and every page is small.
    fireEvent.change(screen.getByLabelText("Search GitHub's actions"), { target: { value: '' } });
    fireEvent.click(screen.getByText(/Show 40 more/));
    expect(screen.getByText('Action 79')).toBeTruthy();
    expect(screen.queryByText('Action 80')).toBeNull();
  });

  it('a page-level search opens the folds that match and hides the rest', () => {
    draw('send email');
    expect(screen.getByText('Send email')).toBeTruthy(); // Gmail opened by the page's search
    expect(screen.queryByText('GitHub')).toBeNull(); // nothing in GitHub matches, so it is not drawn
  });

  /**
   * Retired actions are IN the list (BEA-1365 — nothing skipped): tagged, after the live ones,
   * still found by search — and "retired" itself is a search word.
   */
  it('lists retired actions after the live ones, tagged, and search still finds them', () => {
    const items = [
      { id: 'svc:github.old_star', name: 'GitHub: Old star', description: 'Star a repository (old)', service: 'github', retired: true },
      { id: 'svc:github.create_issue', name: 'GitHub: Create issue', description: 'Open an issue', service: 'github' },
      { id: 'svc:github.star_repo', name: 'GitHub: Star repository', description: 'Star a repository', service: 'github' },
    ];
    expect(liveFirst(items).map((i) => i.id)).toEqual(['svc:github.create_issue', 'svc:github.star_repo', 'svc:github.old_star']);
    render(
      <ServiceFolds
        items={items}
        renderItem={(t, label) => (
          <button key={t.id} data-testid="row">
            {label}
            {t.retired && <RetiredTag />}
          </button>
        )}
      />,
    );
    expect(screen.getByText(/1 retired/)).toBeTruthy(); // the closed fold says how many
    fireEvent.click(screen.getByText('GitHub'));
    const rows = screen.getAllByTestId('row').map((b) => b.textContent);
    expect(rows).toEqual(['Create issue', 'Star repository', 'Old starretired']); // live first, then the tagged retired one
    expect(screen.getAllByText('retired').length).toBe(1);
  });

  it('a page-level search finds a retired action too — and the word "retired" lists exactly those', () => {
    const items = [
      { id: 'svc:github.old_star', name: 'GitHub: Old star', description: 'Star a repository (old)', service: 'github', retired: true },
      { id: 'svc:github.create_issue', name: 'GitHub: Create issue', description: 'Open an issue', service: 'github' },
    ];
    const { unmount } = render(<ServiceFolds items={items} query="old star" renderItem={(t, label) => <button key={t.id}>{label}</button>} />);
    expect(screen.getByText('Old star')).toBeTruthy();
    expect(screen.queryByText('Create issue')).toBeNull();
    unmount();
    render(<ServiceFolds items={items} query="retired" renderItem={(t, label) => <button key={t.id}>{label}</button>} />);
    expect(screen.getByText('Old star')).toBeTruthy();
    expect(screen.queryByText('Create issue')).toBeNull();
  });
});
