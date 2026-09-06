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

  // A bar that page content scrolls UNDER must be opaque below lg:, or the content shows through
  // it — the owner's original "the top portion is blurred" report (BEA-1627, and again in the Vault
  // tabs, BEA-1628). Frosted from lg: up is fine; that is what the app header does.
  it('has no sticky bar that stays translucent below lg:', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = path.resolve(process.cwd(), 'src');
    // Deliberate exceptions, both checked by hand:
    //  FullScreenHtml — floating pill BUTTONS over an arbitrary document, not a bar with content
    //    scrolling under them; translucency is the point.
    //  BriefView — a sticky bottom bar at 95% opacity, where nothing legible comes through.
    const allowed = new Set(['ui/FullScreenHtml.tsx', 'ui/BriefView.tsx']);
    const offenders: string[] = [];
    // Read whole className strings, not lines: a wrapped attribute would otherwise put `sticky`
    // and `backdrop-blur` on different lines and slip through.
    const CLASS_STRINGS = /className=\{?[`"'][^`"']*[`"']/g;
    // A blur is only safe if a WIDTH gates it. `dark:backdrop-blur` is ungated — it is translucent
    // at 390px too, which is exactly the bug this guard exists to catch.
    const widthGated = (token: string) => /(^|:)(sm|md|lg|xl|2xl):/.test(token);
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.tsx$/.test(e.name)) continue;
        const rel = path.relative(src, full);
        if (allowed.has(rel)) continue;
        for (const cs of fs.readFileSync(full, 'utf8').match(CLASS_STRINGS) || []) {
          if (!/\b(sticky|fixed)\b/.test(cs)) continue;
          for (const token of cs.split(/\s+/)) {
            if (token.includes('backdrop-blur') && !widthGated(token)) offenders.push(rel);
          }
        }
      }
    };
    walk(src);
    expect([...new Set(offenders)]).toEqual([]);
  });
});
