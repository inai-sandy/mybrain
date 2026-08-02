import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InstallPrompt } from './InstallPrompt';

/**
 * BEA-1270: as a plain `fixed` element the banner floated over whatever the page put at the top.
 * On a 390px phone at /tasks it covered the top 20px of the tab row, so "My tasks" could not be
 * tapped there. It is only allowed to float from `md:` up, where there is room beside the content.
 */
function fireInstallEvent() {
  fireEvent(window, Object.assign(new Event('beforeinstallprompt'), { prompt: () => {}, userChoice: Promise.resolve() }));
}

function showBanner() {
  render(<InstallPrompt />);
  // The Android path waits for the browser's install event before it shows anything.
  fireInstallEvent();
}

describe('InstallPrompt — never on top of the page on a phone', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is in the page flow on phones and only floats from md: up', () => {
    showBanner();
    const card = screen.getByText('Install My Brain').closest('.rounded-xl');
    const cls = card?.className || '';
    expect(card).toBeTruthy();

    expect(cls).toContain('md:fixed'); // desktop keeps the floating top-right card
    // A bare `fixed`/`absolute` is what caused the overlap — the phone layout must stay in flow.
    expect(cls.split(/\s+/)).not.toContain('fixed');
    expect(cls.split(/\s+/)).not.toContain('absolute');
    // ...and it must not claim a viewport-anchored offset outside the md: breakpoint either.
    expect(cls).not.toMatch(/(^|\s)(top-|inset-x-|right-)/);
  });

  it('still dismisses, and the dismissal sticks', () => {
    showBanner();
    expect(screen.queryByText('Install My Brain')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText('Install My Brain')).toBeNull();
    expect(localStorage.getItem('pwa-install-dismissed')).toBe('1');
  });

  it('stays hidden once it has been dismissed before', () => {
    localStorage.setItem('pwa-install-dismissed', '1');
    showBanner();
    expect(screen.queryByText('Install My Brain')).toBeNull();
  });

  /**
   * The banner now lives inside the page column, so opening Chat unmounts it. Chrome fires
   * `beforeinstallprompt` only once per page load — if that event is held in component state it is
   * gone for good on unmount, and an un-dismissed user silently loses the banner for the whole
   * session. The event is caught at module scope precisely so this cannot happen.
   */
  it('survives a trip to Chat — the install offer is not lost when it unmounts', () => {
    const first = render(<InstallPrompt />);
    fireInstallEvent();
    expect(screen.queryByText('Install My Brain')).toBeTruthy();
    expect(screen.queryByText('Install')).toBeTruthy();

    first.unmount(); // what navigating to /chat does now

    render(<InstallPrompt />); // ...and back to any other page. No second event will ever fire.
    expect(screen.queryByText('Install My Brain')).toBeTruthy();
    expect(screen.queryByText('Install')).toBeTruthy(); // the Install button, so `deferred` came back too
  });
});
