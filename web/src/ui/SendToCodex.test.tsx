import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SendToCodex } from './SendToCodex';

/**
 * "Send to Codex" (BEA-1466).
 *
 * The owner: *"It will just send the transcription after I say ok."* So the tests that matter are
 * about restraint — this must never grow into a "here is what I understood" card, which is the
 * exact shape of every structure that has quietly changed his requirements.
 */
describe('the moment he says ok', () => {
  it('sends, and says plainly that nothing is built yet', () => {
    const onSend = vi.fn();
    render(<SendToCodex tools={['svc:gmail.fetch_emails']} turns={5} onSend={onSend} />);
    fireEvent.click(screen.getByTestId('send-codex'));
    expect(onSend).toHaveBeenCalled();
    expect(screen.getByTestId('send-to-codex')).toHaveTextContent('you read the goal and approve it first');
  });

  it('promises the conversation crosses exactly as written', () => {
    render(<SendToCodex tools={[]} turns={3} onSend={vi.fn()} />);
    expect(screen.getByTestId('send-to-codex')).toHaveTextContent('exactly as written');
  });

  it('shows the tools he named so he can catch a wrong one', () => {
    render(<SendToCodex tools={['svc:gmail.fetch_emails', 'svc:whatsapp.send_text']} turns={4} onSend={vi.fn()} />);
    const el = screen.getByTestId('send-tools');
    expect(el).toHaveTextContent('svc:gmail.fetch_emails');
    expect(el).toHaveTextContent('svc:whatsapp.send_text');
  });

  it('says plainly when he has named none, instead of guessing some', () => {
    render(<SendToCodex tools={[]} turns={4} onSend={vi.fn()} />);
    expect(screen.getByTestId('send-tools')).toHaveTextContent('No tools named yet');
  });

  it('tells him only those go over — not his whole catalogue', () => {
    render(<SendToCodex tools={['svc:gmail.fetch_emails']} turns={4} onSend={vi.fn()} />);
    fireEvent.click(screen.getByTestId('send-tools-note'));
    expect(screen.getByTestId('send-to-codex')).toHaveTextContent('nothing else from your catalogue');
  });

  it('will not send an empty conversation', () => {
    render(<SendToCodex tools={[]} turns={0} onSend={vi.fn()} />);
    expect(screen.getByTestId('send-codex')).toBeDisabled();
    expect(screen.getByTestId('send-to-codex')).toHaveTextContent('Say what you want first');
  });

  it('cannot be double-tapped while it is working', () => {
    render(<SendToCodex tools={[]} turns={4} busy onSend={vi.fn()} />);
    expect(screen.getByTestId('send-codex')).toBeDisabled();
  });

  it('never summarises the conversation — no counts, no "what I understood"', () => {
    render(<SendToCodex tools={['svc:gmail.fetch_emails']} turns={9} onSend={vi.fn()} />);
    const el = screen.getByTestId('send-to-codex');
    // THE point of this component. If a summary, a topic, a title or a "you asked for…" ever appears
    // here, the app has started interpreting his conversation again.
    expect(el).not.toHaveTextContent(/what I understood|you asked for|in summary|topic:/i);
  });
});
