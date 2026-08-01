import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from './ChatInput';

/**
 * BEA-1251 — "When I click on Enter, it is immediately sending a message. Is there any way I can
 * go to a new line?" Before this, the chat inputs were single-line <input> boxes with Enter
 * hard-wired to send: a new line was impossible, and a mid-thought Enter fired the message.
 */

function matchMediaStub(coarse: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: q.includes('coarse') ? coarse : false,
    media: q, addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  })) as any;
}

describe('ChatInput (BEA-1251)', () => {
  beforeEach(() => matchMediaStub(false));

  it('is a real multi-line textarea, not a single-line input', () => {
    render(<ChatInput value="line one" onChange={() => undefined} onSend={() => undefined} />);
    expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA');
  });

  it('Enter sends on a keyboard device', () => {
    const onSend = vi.fn();
    render(<ChatInput value="hello" onChange={() => undefined} onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter does NOT send — it makes a new line', () => {
    const onSend = vi.fn();
    render(<ChatInput value="hello" onChange={() => undefined} onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('on a touch device Enter does NOT send — the send button does', () => {
    matchMediaStub(true);
    const onSend = vi.fn();
    render(<ChatInput value="hello" onChange={() => undefined} onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('the send button is disabled while empty or busy', () => {
    const { rerender } = render(<ChatInput value="" onChange={() => undefined} onSend={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    rerender(<ChatInput value="hi" onChange={() => undefined} onSend={() => undefined} busy />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
