import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('is open by default when rendered conditionally (no open prop) and confirms', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Delete task?" message="x" onConfirm={onConfirm} onCancel={() => {}} />);
    expect(screen.getByText('Delete task?')).toBeTruthy();
    fireEvent.click(screen.getByText('Delete'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('renders nothing when open is false', () => {
    render(<ConfirmDialog open={false} title="Hidden?" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText('Hidden?')).toBeNull();
  });
});
