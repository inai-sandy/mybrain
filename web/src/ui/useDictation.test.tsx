import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDictation, isDictating, finishDictation } from './useDictation';

// jsdom has no AudioContext, so `canStream` is false and the hook takes the record-then-send
// road — which is the one that uses the mic stream and MediaRecorder. That is what we want here.
const streams: { getTracks: () => any[]; track: { stop: ReturnType<typeof vi.fn> } }[] = [];

function fakeStream() {
  const track = { stop: vi.fn() };
  const s = { getTracks: () => [track], track };
  streams.push(s);
  return s;
}

class FakeRecorder {
  state = 'recording';
  mimeType = 'audio/webm';
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  static isTypeSupported() { return true; }
  start() { this.ondataavailable?.({ data: new Blob(['x']) }); }
  stop() { this.state = 'inactive'; this.onstop?.(); }
}

function Two() {
  const a = useDictation(() => undefined);
  const b = useDictation(() => undefined);
  return (
    <>
      <button data-testid="a" onClick={() => (a.active ? a.stop() : a.start())}>A {a.active ? 'on' : 'off'}</button>
      <button data-testid="b" onClick={() => (b.active ? b.stop() : b.start())}>B {b.active ? 'on' : 'off'}</button>
    </>
  );
}

describe('useDictation', () => {
  beforeEach(() => {
    streams.length = 0;
    (navigator as any).mediaDevices = { getUserMedia: vi.fn(async () => fakeStream()) };
    (window as any).MediaRecorder = FakeRecorder;
    (global as any).fetch = vi.fn(async (url: string) => {
      if (String(url).includes('stream-token')) return { ok: true, json: async () => ({ available: false }) };
      return { ok: true, json: async () => ({ text: 'hello' }) };
    });
  });

  // The dictation status is ONE module-level object shared by every mic, so unmounting the
  // components does not reset it. Settle it back to idle or the next test inherits a live mic.
  afterEach(async () => {
    await act(async () => {
      finishDictation();
      await waitFor(() => expect(isDictating()).toBe(false));
    });
  });

  it('opens only ONE mic — tapping a second one closes the first (BEA-1626)', async () => {
    render(<Two />);
    fireEvent.click(screen.getByTestId('a'));
    await waitFor(() => expect(screen.getByTestId('a').textContent).toContain('on'));
    expect((navigator as any).mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(streams[0].track.stop).not.toHaveBeenCalled();

    // A page can carry three mics; tapping a second one must not leave two streams open.
    fireEvent.click(screen.getByTestId('b'));
    await waitFor(() => expect(screen.getByTestId('b').textContent).toContain('on'));
    await waitFor(() => expect(streams[0].track.stop).toHaveBeenCalled()); // the first mic was released
    expect(screen.getByTestId('a').textContent).toContain('off');
  });

  it('holds a modal open while listening — the words are only delivered when stop() finishes', async () => {
    render(<Two />);
    expect(isDictating()).toBe(false);
    fireEvent.click(screen.getByTestId('a'));
    await waitFor(() => expect(screen.getByTestId('a').textContent).toContain('on'));
    // NOT narrowed to the transcribing window: onText fires at the END of stop(), so unmounting
    // the box while merely listening throws the whole dictation away. Releasing the mic is not the
    // same as keeping the words.
    expect(isDictating()).toBe(true);
  });

  it('finishDictation() ends a live mic and reports whether there was one', async () => {
    render(<Two />);
    expect(finishDictation()).toBe(false); // nothing running — a modal may close straight away
    fireEvent.click(screen.getByTestId('a'));
    await waitFor(() => expect(screen.getByTestId('a').textContent).toContain('on'));

    expect(finishDictation()).toBe(true); // the close is refused ONCE, and the mic is finishing
    await waitFor(() => expect(streams[0].track.stop).toHaveBeenCalled());
    await waitFor(() => expect(isDictating()).toBe(false));
    expect(finishDictation()).toBe(false); // now a second tap closes
  });

  it('a second tap during the hand-over does not open a third mic', async () => {
    render(<Two />);
    fireEvent.click(screen.getByTestId('a'));
    await waitFor(() => expect(screen.getByTestId('a').textContent).toContain('on'));

    // Both taps land while start() is awaiting the other mic's stop(). The slot must be claimed
    // synchronously, or the second call runs a second start() over the same refs and orphans a
    // stream that nothing is left holding.
    fireEvent.click(screen.getByTestId('b'));
    fireEvent.click(screen.getByTestId('b'));
    await waitFor(() => expect(screen.getByTestId('b').textContent).toContain('on'));
    expect((navigator as any).mediaDevices.getUserMedia).toHaveBeenCalledTimes(2); // A, then B — never three
  });
});
