import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BriefProposalCard } from './BriefProposalCard';

/**
 * The short card in the chat (BEA-1424).
 *
 * Deliberately NOT the brief. Putting the whole thing in a chat bubble is how it becomes the wall of
 * text he scrolls past — the exact failure BEA-1416 exists to prevent. What belongs here is only
 * enough to decide whether to open it.
 */

const card = (over: any = {}) => ({
  name: 'Nightly email summary',
  guesses: 3,
  lines: 8,
  sources: ['Gmail · fetch emails'],
  sends: true,
  ...over,
});

describe('the brief card in the chat', () => {
  it('says how much of it is the AI guessing — the number that says how much checking to do', () => {
    render(<BriefProposalCard card={card()} onOpen={vi.fn()} />);
    expect(screen.getByTestId('brief-guess-count')).toHaveTextContent('3 of the 8 lines are my guess, not yours');
  });

  it('says so plainly when it is all his words', () => {
    render(<BriefProposalCard card={card({ guesses: 0 })} onOpen={vi.fn()} />);
    expect(screen.getByTestId('brief-guess-count')).toHaveTextContent('nothing — it is all your words');
  });

  it('gets the grammar right for one', () => {
    render(<BriefProposalCard card={card({ guesses: 1, lines: 5 })} onOpen={vi.fn()} />);
    expect(screen.getByTestId('brief-guess-count')).toHaveTextContent('1 of the 5 lines is my guess');
  });

  it('says what it fetches', () => {
    render(<BriefProposalCard card={card()} onOpen={vi.fn()} />);
    expect(screen.getByTestId('builder-brief')).toHaveTextContent('Gmail · fetch emails');
  });

  it('does NOT put the message in the chat — it lives on the brief screen', () => {
    render(<BriefProposalCard card={card()} onOpen={vi.fn()} />);
    expect(screen.getByTestId('builder-brief')).toHaveTextContent('the exact message is in the brief');
  });

  it('says nothing about telling him when nothing is being sent', () => {
    render(<BriefProposalCard card={card({ sends: false })} onOpen={vi.fn()} />);
    expect(screen.getByTestId('builder-brief')).not.toHaveTextContent(/Tells you/);
  });

  it('promises plainly that pressing it builds nothing', () => {
    render(<BriefProposalCard card={card()} onOpen={vi.fn()} />);
    expect(screen.getByTestId('builder-brief')).toHaveTextContent('Nothing is built yet');
    expect(screen.getByTestId('builder-brief')).toHaveTextContent('only then keep it');
  });

  it('opens it', () => {
    const onOpen = vi.fn();
    render(<BriefProposalCard card={card()} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId('brief-open'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('cannot be pressed twice while it is opening', () => {
    const onOpen = vi.fn();
    render(<BriefProposalCard card={card()} opening onOpen={onOpen} />);
    expect(screen.getByTestId('brief-open')).toBeDisabled();
  });
});
