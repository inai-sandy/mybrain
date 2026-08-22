import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Trial, TrialCard, TrialState } from './TrialCard';

/**
 * The second gate, on screen (BEA-1408).
 *
 * He is judging a real result here, not a description of one. Everything this screen says has to be
 * true of what actually happened — including, loudly, that nothing was saved and nothing was sent.
 */

const MESSAGE = 'Last night · 31 mails\n\nWork (14)\n• Ravi — quote needs a reply today';

function trial(over: Partial<Trial> = {}): Trial {
  return {
    id: 't1',
    status: 'passed',
    columns: ['subject', 'from'],
    rows: [['A quote for you', 'ravi@x.com'], ['Dinner?', 'amma@x.com']],
    rowCount: 47,
    message: MESSAGE,
    credits: 3,
    aiTokens: 1200,
    verdict: 'It met what you asked for: at least 20 mails read.',
    error: '',
    ...over,
  };
}

function view(state: Partial<TrialState> = {}, handlers: any = {}) {
  const props = {
    state: { trial: trial(), canCreate: true, whyNot: '', running: false, ...state } as TrialState,
    onRun: vi.fn(),
    onCreate: vi.fn(),
    onSendBack: vi.fn(),
    ...handlers,
  };
  render(<TrialCard {...props} />);
  return props;
}

describe('before anything has run', () => {
  it('offers to run it, and promises plainly that nothing leaves the building', () => {
    const p = view({ trial: null, canCreate: false, whyNot: 'Run it once first.' });
    expect(screen.getByText(/Nothing is saved, and nothing is sent to anyone/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('trial-run'));
    expect(p.onRun).toHaveBeenCalled();
  });
});

describe('while it is going', () => {
  it('says it is writing the program, and that it takes a couple of minutes', () => {
    view({ trial: trial({ status: 'building' }), running: true, canCreate: false });
    expect(screen.getByTestId('trial-running')).toHaveTextContent(/Building it/i);
    expect(screen.getByText(/couple of minutes/i)).toBeTruthy();
  });

  it('says it is fetching for real, and saving nothing', () => {
    view({ trial: trial({ status: 'running' }), running: true, canCreate: false });
    expect(screen.getByTestId('trial-running')).toHaveTextContent(/Fetching for real/i);
    expect(screen.getByText(/nothing is being sent/i)).toBeTruthy();
  });
});

describe('when it worked', () => {
  it('shows the REAL count, not the number of rows it happens to display', () => {
    view();
    // 47 fetched, 2 shown. Showing "2 things" would be its own small lie.
    expect(screen.getByText(/47/)).toBeTruthy();
    expect(screen.getByTestId('trial-result')).toHaveTextContent(/the first 2 are below/i);
  });

  it('says nothing was saved and nothing was sent, at the top', () => {
    view();
    expect(screen.getByTestId('trial-result')).toHaveTextContent(/Nothing was saved and nothing was sent/i);
  });

  it('shows the real rows in a table that scrolls inside itself', () => {
    view();
    const table = screen.getByTestId('trial-rows');
    expect(within(table).getByText('A quote for you')).toBeTruthy();
    expect(within(table).getByText('amma@x.com')).toBeTruthy();
    expect(table.closest('.overflow-x-auto')).toBeTruthy();
  });

  it('shows the exact message he would receive', () => {
    view();
    expect(screen.getByTestId('trial-message')).toHaveTextContent('Work (14)');
    expect(screen.getByText(/What it would send you/i)).toBeTruthy();
  });

  it('reads his own success sentence back to him', () => {
    view();
    expect(screen.getByTestId('trial-verdict')).toHaveTextContent(/at least 20 mails read/i);
  });

  it('says what it cost', () => {
    view();
    expect(screen.getByTestId('trial-result')).toHaveTextContent(/3 credits/);
  });

  it('says "nothing" rather than "0 credits"', () => {
    view({ trial: trial({ credits: 0 }) });
    expect(screen.getByTestId('trial-result')).toHaveTextContent(/cost nothing/i);
  });

  it('keeps it, or sends it back with one sentence', () => {
    const p = view();
    fireEvent.click(screen.getByTestId('trial-create'));
    expect(p.onCreate).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('trial-send-back'));
    fireEvent.change(screen.getByLabelText('What was wrong with it'), { target: { value: 'Too much detail.' } });
    fireEvent.click(screen.getByTestId('send-back-save'));
    expect(p.onSendBack).toHaveBeenCalledWith('Too much detail.');
  });

  it('sending it to his phone is a separate, deliberate tap', () => {
    const onSendToMe = vi.fn();
    view({}, { onSendToMe });
    fireEvent.click(screen.getByTestId('trial-send-to-me'));
    expect(onSendToMe).toHaveBeenCalled();
  });

  it('offers no send button at all when nobody asked for a message', () => {
    view({ trial: trial({ message: '' }) });
    expect(screen.queryByTestId('trial-message')).toBeNull();
    expect(screen.queryByTestId('trial-send-to-me')).toBeNull();
  });

  it('Create is refused, with the reason, when the brief moved on', () => {
    const p = view({ canCreate: false, whyNot: 'You changed the brief after that run.' });
    expect(screen.getByTestId('trial-create')).toBeDisabled();
    expect(screen.getByTestId('trial-whynot')).toHaveTextContent(/changed the brief after that run/i);
    fireEvent.click(screen.getByTestId('trial-create'));
    expect(p.onCreate).not.toHaveBeenCalled();
  });
});

describe('when it failed', () => {
  it('says what went wrong, and that nothing was saved anyway', () => {
    const p = view({ trial: trial({ status: 'failed', error: 'Gmail gave back one email.' }), canCreate: false });
    expect(screen.getByTestId('trial-failed')).toHaveTextContent('Gmail gave back one email.');
    expect(screen.getByText(/Nothing was saved and nothing was sent/i)).toBeTruthy();
    // And it never offers Create.
    expect(screen.queryByTestId('trial-create')).toBeNull();
    fireEvent.click(screen.getByTestId('trial-rerun'));
    expect(p.onRun).toHaveBeenCalled();
  });
});
