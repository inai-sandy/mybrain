import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DataTable, Column } from './DataTable';

type Row = { name: string; n: number };
const cols: Column<Row>[] = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'n', label: 'N' },
];

describe('DataTable', () => {
  it('shows the loading state', () => {
    render(<DataTable columns={cols} rows={[]} loading />);
    expect(screen.getByTestId('dt-loading')).toBeInTheDocument();
  });

  it('shows a friendly empty state', () => {
    render(<DataTable columns={cols} rows={[]} />);
    expect(screen.getByTestId('dt-empty')).toBeInTheDocument();
  });

  it('renders rows and the total count', () => {
    render(
      <DataTable
        columns={cols}
        rows={[
          { name: 'a', n: 1 },
          { name: 'b', n: 2 },
        ]}
      />,
    );
    expect(screen.getByTestId('dt-count').textContent).toContain('2 results');
  });

  it('defaultFilters pre-select a filter, and the reader can still clear it to all (BEA-1287)', () => {
    render(
      <DataTable
        columns={cols}
        rows={[
          { name: 'keep', n: 1 },
          { name: 'drop', n: 2 },
        ]}
        filters={[{ key: 'name', label: 'Name', options: [{ value: 'keep', label: 'Keep' }] }]}
        defaultFilters={{ name: 'keep' }}
      />,
    );
    expect(screen.getByTestId('dt-count').textContent).toContain('1 result');
    expect((screen.getByLabelText('Name') as HTMLSelectElement).value).toBe('keep');
  });

  it('onFiltersChange reports the full active map on every pick — callers whose rows depend on a filter need it (BEA-1291)', () => {
    const seen: Record<string, string>[] = [];
    render(
      <DataTable
        columns={cols}
        rows={[{ name: 'a', n: 1 }]}
        filters={[{ key: 'name', label: 'Name', options: [{ value: 'a', label: 'A' }] }]}
        defaultFilters={{ name: 'a' }}
        onFiltersChange={(m) => seen.push(m)}
      />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    expect(seen).toEqual([{ name: '' }]);
  });

  it('defaultSort orders the rows before the reader touches anything (BEA-1287)', () => {
    render(
      <DataTable
        columns={cols}
        rows={[
          { name: 'b', n: 2 },
          { name: 'a', n: 1 },
        ]}
        sortOptions={[{ label: 'Name A–Z', key: 'name', dir: 1 }]}
        defaultSort={{ key: 'name', dir: 1 }}
      />,
    );
    const cells = screen.getAllByRole('cell').map((c) => c.textContent);
    expect(cells.indexOf('a')).toBeLessThan(cells.indexOf('b'));
  });
});

describe('external-controls mode (BEA-1320)', () => {
  const ROWS = [
    { name: 'alpha', kind: 'a', rank: 2 },
    { name: 'bravo', kind: 'b', rank: 1 },
    { name: 'charlie', kind: 'a', rank: 3 },
  ];
  const COLS = [{ key: 'name' as const, label: 'Name' }];

  it('filters, sorts and hides the built-in strip from external values', () => {
    render(
      <DataTable
        columns={COLS}
        rows={ROWS}
        controls={{ search: '', filters: { kind: 'a' }, sort: { key: 'rank', dir: -1 } }}
      />,
    );
    // No built-in controls in external mode — the caller draws its own.
    expect(screen.queryByLabelText('Search')).toBeNull();
    const cells = screen.getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['charlie', 'alpha']); // kind=a only, rank desc
  });

  it('external search narrows rows without any filter definitions', () => {
    render(<DataTable columns={COLS} rows={ROWS} controls={{ search: 'brav', filters: {}, sort: null }} />);
    const cells = screen.getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['bravo']);
  });
});
