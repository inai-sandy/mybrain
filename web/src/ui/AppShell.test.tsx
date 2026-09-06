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
    // Theme toggle lives in the account menu now — open it first.
    fireEvent.click(screen.getByLabelText('Account menu'));
    fireEvent.click(screen.getByLabelText('Toggle dark mode'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  // BEA-1627: a tablet (768-1023) must get the phone's layout, not a squeezed desktop one.
  // jsdom does not apply media queries to Tailwind classes, so this asserts the breakpoints
  // themselves — which is exactly what regressed: everything switched at md: (768px).
  it('switches the shell at lg:, so a tablet gets the drawer and a solid header', () => {
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );

    // The header is solid below 1024 — scrolled content must not show through it on a tablet.
    const header = document.querySelector('header')!;
    expect(header.className).toContain('lg:backdrop-blur');
    expect(header.className).not.toContain('md:backdrop-blur');
    expect(header.className).not.toContain('md:bg-white/80');

    // The 240px sidebar only appears once there is room for it.
    const aside = document.querySelector('aside')!;
    expect(aside.className).toContain('lg:flex');
    expect(aside.className).toContain('lg:fixed');
    expect(aside.className).not.toContain('md:flex');
    expect(aside.className).not.toContain('md:w-60');

    // …and until then the hamburger is what opens the nav.
    const menu = screen.getByLabelText('Menu');
    expect(menu.className).toContain('lg:hidden');
    expect(menu.className).not.toContain('md:hidden');

    // The page column only reserves room for the sidebar when the sidebar is there.
    const column = aside.parentElement!.parentElement!.querySelector('header')!.parentElement!;
    expect(column.className).toMatch(/lg:pl-(16|60)/);
    expect(column.className).not.toMatch(/md:pl-/);
  });

  // The chat button, the toasts, the dictation banner and every page's floating capture button were
  // positioned against each other at md:. Moving only some of them decouples the pair on a tablet —
  // which is exactly what the first pass of BEA-1627 did. This catches that for good.
  it('leaves no bottom-anchored control still switching at md:', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = path.resolve(process.cwd(), 'src'); // vitest runs from web/
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    walk(src);
    const stale = files.filter((f) => /md:(bottom-|left-auto|right-24|right-6)/.test(fs.readFileSync(f, 'utf8')));
    expect(stale.map((f) => path.relative(src, f))).toEqual([]);
  });
});
