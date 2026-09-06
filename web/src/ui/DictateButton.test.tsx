import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A stateful stand-in for useDictation, so these tests are about the BUTTON's contract:
// tap on, tap off, and never stopping just because a finger came up. (BEA-1626)
const h = vi.hoisted(() => ({ active: false, starts: 0, stops: 0, listeners: new Set<() => void>() }));

vi.mock('./useDictation', async () => {
  const React = await import('react');
  const bump = () => h.listeners.forEach((f) => f());
  return {
    useDictation: () => {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const f = () => force((x) => x + 1);
        h.listeners.add(f);
        return () => { h.listeners.delete(f); };
      }, []);
      return {
        supported: true,
        active: h.active,
        start: () => { h.starts++; h.active = true; bump(); },
        stop: () => { h.stops++; h.active = false; bump(); },
      };
    },
  };
});

import { DictateButton } from './DictateButton';

const mic = () => screen.getByRole('button');

describe('DictateButton — tap to talk', () => {
  beforeEach(() => { h.active = false; h.starts = 0; h.stops = 0; });

  it('starts on one tap and does NOT stop when the finger comes up', () => {
    render(<DictateButton onText={() => undefined} />);
    fireEvent.pointerDown(mic());
    expect(h.starts).toBe(1);

    // The whole point of the change: releasing anywhere used to end the recording.
    fireEvent.pointerUp(window);
    fireEvent.mouseUp(window);
    fireEvent.touchEnd(window);
    fireEvent.blur(window);
    expect(h.stops).toBe(0);
    expect(h.active).toBe(true);
  });

  it('stops on the second tap', () => {
    render(<DictateButton onText={() => undefined} />);
    fireEvent.pointerDown(mic());
    fireEvent.pointerDown(mic());
    expect(h.starts).toBe(1);
    expect(h.stops).toBe(1);
    expect(h.active).toBe(false);
  });

  it('says it is recording, so he is never live without knowing', () => {
    render(<DictateButton onText={() => undefined} />);
    expect(mic()).toHaveAttribute('aria-label', 'Start dictation');
    expect(mic()).toHaveAttribute('data-recording', 'no');

    fireEvent.pointerDown(mic());
    expect(mic()).toHaveAttribute('aria-label', 'Stop dictation');
    expect(mic()).toHaveAttribute('aria-pressed', 'true');
    expect(mic()).toHaveAttribute('data-recording', 'yes');
    expect(mic().className).toContain('bg-rose-500');
  });

  it('releases the mic if it unmounts mid-recording', () => {
    const { unmount } = render(<DictateButton onText={() => undefined} />);
    fireEvent.pointerDown(mic());
    expect(h.active).toBe(true);
    unmount();
    expect(h.stops).toBe(1);
  });

  it('renders nothing when the device cannot record', async () => {
    vi.resetModules();
    vi.doMock('./useDictation', () => ({ useDictation: () => ({ supported: false, active: false, start: () => undefined, stop: () => undefined }) }));
    const { DictateButton: Unsupported } = await import('./DictateButton');
    const { container } = render(<Unsupported onText={() => undefined} />);
    expect(container.firstChild).toBeNull();
    vi.doUnmock('./useDictation');
  });
});
