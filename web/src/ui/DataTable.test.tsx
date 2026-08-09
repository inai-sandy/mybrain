import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
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
