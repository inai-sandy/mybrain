import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GoalView, Goal } from './GoalView';

/**
 * THE GOAL screen (BEA-1463).
 *
 * The owner deleted the brief because the app was reading his conversation and writing structure
 * from it, and every structure it invented reached him as a defect. So the strongest tests here
 * assert an ABSENCE: Codex's text is shown exactly as written, and nothing on this screen parses,
 * scores, re-orders or summarises it.
 */

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1',
  version: 1,
  status: 'proposed',
  text: 'This agent reads your Gmail at 22:00 each night.\n\nIt keeps the messages that need you — a person wrote them, or money is involved — and sends those summaries to your WhatsApp, in the message itself rather than behind a link.\n\nAssumption: "important" means from a human or about an invoice. Correct me if that is wrong.',
  tools: ['svc:gmail.fetch_emails'],
  ...over,
});

const noop = { onApprove: vi.fn(), onSendBack: vi.fn(), onAnswer: vi.fn() };

describe('the goal is shown as Codex wrote it', () => {
  it('renders the text whole, including the line breaks', () => {
    render(<GoalView goal={goal()} {...noop} />);
    const el = screen.getByTestId('goal-text');
    expect(el).toHaveTextContent('reads your Gmail at 22:00');
    expect(el).toHaveTextContent('in the message itself rather than behind a link');
    // The assumption Codex flagged must survive to the screen — it is the thing he is meant to catch.
    expect(el).toHaveTextContent('Correct me if that is wrong');
  });

  it('does not summarise, score or count anything about it', () => {
    render(<GoalView goal={goal()} {...noop} />);
    const view = screen.getByTestId('goal-view');
    // No word counts, no "3 sections", no confidence, no extracted headings. If any of these appear,
    // the app has started reading the goal instead of showing it.
    expect(view).not.toHaveTextContent(/\d+ (sections?|lines?|points?|steps?|words?)/i);
    expect(view).not.toHaveTextContent(/confidence|score|summary of/i);
  });

  it('names the tools he chose, without adding any', () => {
    render(<GoalView goal={goal()} {...noop} />);
    expect(screen.getByTestId('goal-tools')).toHaveTextContent('svc:gmail.fetch_emails');
  });

  it('promises plainly that nothing is built yet', () => {
    render(<GoalView goal={goal()} {...noop} />);
    expect(screen.getByTestId('goal-view')).toHaveTextContent('Nothing is built until you approve this');
  });
});

describe('the three things he can do', () => {
  it('approves it', () => {
    const onApprove = vi.fn();
    render(<GoalView goal={goal()} {...noop} onApprove={onApprove} />);
    fireEvent.click(screen.getByTestId('goal-approve'));
    expect(onApprove).toHaveBeenCalled();
  });

  it('sends it back with his own words', () => {
    const onSendBack = vi.fn();
    render(<GoalView goal={goal()} {...noop} onSendBack={onSendBack} />);
    fireEvent.click(screen.getByTestId('goal-change'));
    fireEvent.change(screen.getByTestId('goal-note'), { target: { value: 'I want it at 21:00, not 22:00' } });
    fireEvent.click(screen.getByTestId('goal-send-back'));
    expect(onSendBack).toHaveBeenCalledWith('I want it at 21:00, not 22:00');
  });

  it('will not send it back empty — that sentence is the whole point', () => {
    render(<GoalView goal={goal()} {...noop} />);
    fireEvent.click(screen.getByTestId('goal-change'));
    expect(screen.getByTestId('goal-send-back')).toBeDisabled();
  });

  it('cannot be double-tapped while it is working', () => {
    render(<GoalView goal={goal()} busy {...noop} />);
    expect(screen.getByTestId('goal-approve')).toBeDisabled();
  });
});

describe('when Codex asks him something instead', () => {
  it('shows the question and offers NOTHING to approve', () => {
    render(<GoalView goal={goal({ status: 'asking', text: '', question: 'Which Gmail account — the work one or the personal one?' })} {...noop} />);
    expect(screen.getByTestId('goal-asking')).toHaveTextContent('work one or the personal one');
    // THE point. Approving a question mark is how a guess quietly becomes a requirement.
    expect(screen.queryByTestId('goal-approve')).toBeNull();
    expect(screen.queryByTestId('goal-text')).toBeNull();
  });

  it('sends his answer back', () => {
    const onAnswer = vi.fn();
    render(<GoalView goal={goal({ status: 'asking', text: '', question: 'Which account?' })} {...noop} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByTestId('goal-answer'), { target: { value: 'the work one' } });
    fireEvent.click(screen.getByTestId('goal-answer-send'));
    expect(onAnswer).toHaveBeenCalledWith('the work one');
  });

  it('will not send an empty answer', () => {
    render(<GoalView goal={goal({ status: 'asking', text: '', question: 'Which account?' })} {...noop} />);
    expect(screen.getByTestId('goal-answer-send')).toBeDisabled();
  });
});

describe('once he has approved it', () => {
  it('says what happens next, and stops offering the buttons', () => {
    render(<GoalView goal={goal({ status: 'approved', approvedAt: '2026-08-25T04:00:00Z' })} {...noop} />);
    expect(screen.getByTestId('goal-approved')).toBeTruthy();
    expect(screen.queryByTestId('goal-approve')).toBeNull();
    // His design: "run a sample task to match the goal. verify the goal and the output."
    expect(screen.getByTestId('goal-view')).toHaveTextContent('run once and check the result against this goal');
  });
});

describe('before he has sent anything over', () => {
  it('says so plainly rather than showing an empty box', () => {
    cleanup();
    render(<GoalView goal={null} {...noop} />);
    expect(screen.getByTestId('goal-none')).toHaveTextContent('Codex will tell you what it is going to build');
  });
});
