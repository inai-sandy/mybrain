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
});
