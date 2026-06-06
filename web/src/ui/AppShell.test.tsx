import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('renders the shell and toggles dark mode', () => {
    render(<AppShell>hello</AppShell>);
    expect(screen.getByText('My Brain')).toBeInTheDocument();

    // Default theme is dark → <html> has the dark class.
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    fireEvent.click(screen.getByLabelText('Toggle dark mode'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
