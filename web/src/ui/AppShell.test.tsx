import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('renders the nav and toggles dark mode', () => {
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );
    // Brand appears (sidebar + mobile bar); nav items render.
    expect(screen.getAllByText('My Brain').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Home').length).toBeGreaterThan(0);

    // Default theme is dark; toggle flips it.
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    fireEvent.click(screen.getByLabelText('Toggle dark mode'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
