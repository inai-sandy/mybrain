import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToolPicker } from './ToolPicker';

/**
 * The picker on a service with hundreds of actions (BEA-1354): the Services group is folded per
 * service with a count, opening a service gives search-within-service and one page — it never draws
 * all ~800 GitHub actions at once.
 */
const github = Array.from({ length: 800 }, (_, i) => ({
  id: `svc:github.action_${i}`, name: `GitHub: Action ${i}`, group: 'Services', kind: 'tool', connected: true,
  description: i === 640 ? 'Star a repository for the authenticated user' : `Does thing ${i}`, service: 'github',
}));
const catalog = {
  groups: [
    { group: 'Brain', tools: [{ id: 'search_brain', name: 'Search my brain', group: 'Brain', kind: 'tool', connected: true, description: 'Everything you saved' }] },
    { group: 'Services', tools: github },
  ],
  tools: [] as any[],
};
catalog.tools = catalog.groups.flatMap((g) => g.tools);

describe('ToolPicker with a huge service', () => {
  afterEach(() => vi.restoreAllMocks());
  window.scrollTo = vi.fn() as any; // jsdom has none; the Sheet's scroll lock calls it on close

  it('folds the service, searches within it, and never renders all of it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => catalog })));
    render(<ToolPicker value={[]} onSave={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Search my brain')).toBeTruthy());

    // Folded: the service and its count, not its rows.
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.getAllByText(/800 actions/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Action 0')).toBeNull();

    // Open it: one page and a search box of its own.
    fireEvent.click(screen.getByText('GitHub'));
    expect(screen.getByText('Action 0')).toBeTruthy();
    expect(screen.queryByText('Action 40')).toBeNull();
    fireEvent.change(screen.getByLabelText("Search GitHub's actions"), { target: { value: 'star repository' } });
    expect(screen.getByText('Action 640')).toBeTruthy();
    expect(screen.queryByText('Action 0')).toBeNull();
    // Ticking one from deep in the list counts on the fold.
    fireEvent.click(screen.getByText('Action 640'));
    expect(screen.getAllByText(/1 picked/).length).toBe(2); // the fold's count and the footer's
  });
});
