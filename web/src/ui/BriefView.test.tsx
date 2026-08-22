import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Brief, BriefView, MessagePreview, OriginTag, SECTION_LABELS } from './BriefView';

/**
 * The screen's one job (BEA-1406): he can tell his own words from the AI's guesses without reading
 * them. On the night that started this, both were printed in the same colour in the same paragraph,
 * and he approved an invention.
 */

function brief(over: Partial<Brief> = {}): Brief {
  return {
    id: 'b1',
    areaId: 'a1',
    version: 1,
    status: 'draft',
    name: 'Nightly email summary',
    sections: {
      want: [{ id: 'l1', text: 'Read all my important emails and WhatsApp me a summary.', origin: 'owner' }],
      sources: [{ id: 'l2', text: 'I looked at Gmail and got 47 emails.', origin: 'tool', evidence: { callId: 'tc1' } }],
      filter: [{ id: 'l3', text: 'Skip newsletters and receipts.', origin: 'ai' }],
      output: [],
      when: [],
      success: [],
      trouble: [],
      killed: [],
    },
    sources: [],
    delivery: { whatsapp: true, telegram: false, messageText: 'Last night · 31 mails\nWork (14) — two need a reply' },
    transcript: [],
    ...over,
  } as Brief;
}

function view(over: Partial<Brief> = {}, refusals: any[] = [], handlers: any = {}) {
  const props = {
    brief: brief(over),
    refusals,
    onEdit: vi.fn(),
    onStrike: vi.fn(),
    onAdd: vi.fn(),
    onMessage: vi.fn(),
    onApprove: vi.fn(),
    onProof: vi.fn(),
    ...handlers,
  };
  render(<BriefView {...props} />);
  return props;
}

describe('the brief screen', () => {
  it('marks the AI\'s guess differently from his own words, without reading the text', () => {
    view();
    // Three different tags, each with its own word — colour is never the only signal.
    expect(screen.getByTestId('tag-owner')).toHaveTextContent(/your words/i);
    expect(screen.getByTestId('tag-tool')).toHaveTextContent(/looked/i);
    expect(screen.getByTestId('tag-ai')).toHaveTextContent(/my guess/i);
  });

  it('draws every section, in order, with plain headings', () => {
    view();
    for (const [k, label] of Object.entries(SECTION_LABELS)) {
      expect(within(screen.getByTestId(`brief-section-${k}`)).getByText(label)).toBeTruthy();
    }
  });

  it('an empty section says what that means, not "no data"', () => {
    view();
    expect(within(screen.getByTestId('brief-section-success')).getByText(/nothing can tell a bad run from a good one/i)).toBeTruthy();
  });

  // ---- the refusals land beside the hole -----------------------------------------------------------

  it('shows the reason next to the section it belongs to, not in a toast', () => {
    view({}, [{ section: 'success', why: 'Tell me what would make this a good run.' }]);
    const inSection = within(screen.getByTestId('brief-section-success')).getByTestId('refusal-success');
    expect(inSection).toHaveTextContent('Tell me what would make this a good run.');
    // And nowhere else.
    expect(screen.queryByTestId('refusal-want')).toBeNull();
  });

  it('says how many things are still to sort out', () => {
    view({}, [{ section: 'success', why: 'x' }, { section: 'sources', why: 'y' }]);
    expect(screen.getByText(/2 things still to sort out/i)).toBeTruthy();
  });

  // ---- editing -------------------------------------------------------------------------------------

  it('editing a line tells him it becomes his words, and sends the change', () => {
    const p = view();
    fireEvent.click(within(screen.getAllByTestId('brief-line')[0]).getByTestId('line-edit'));
    expect(screen.getByText(/becomes your words/i)).toBeTruthy();
    const box = screen.getByLabelText('Edit this line') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Only mail from real people.' } });
    fireEvent.click(screen.getByTestId('line-save'));
    expect(p.onEdit).toHaveBeenCalledWith('l1', 'Only mail from real people.');
  });

  it('an unchanged line is not saved for nothing', () => {
    const p = view();
    fireEvent.click(within(screen.getAllByTestId('brief-line')[0]).getByTestId('line-edit'));
    fireEvent.click(screen.getByTestId('line-save'));
    expect(p.onEdit).not.toHaveBeenCalled();
  });

  // ---- striking -------------------------------------------------------------------------------------

  it('crossing out a line asks the server to strike it, not delete it', () => {
    const p = view();
    fireEvent.click(within(screen.getAllByTestId('brief-line')[0]).getByTestId('line-strike'));
    expect(p.onStrike).toHaveBeenCalledWith('l1', true);
  });

  it('a struck line is still readable, and can be brought back', () => {
    const p = view({
      sections: { ...brief().sections, killed: [{ id: 'lk', text: 'Also post it to Telegram.', origin: 'ai', struck: true }] },
    });
    const killed = screen.getByTestId('brief-killed');
    expect(within(killed).getByText('Also post it to Telegram.')).toBeTruthy();
    expect(within(killed).getByText(/nothing quietly builds them again/i)).toBeTruthy();
    fireEvent.click(within(killed).getByTestId('line-unstrike'));
    expect(p.onStrike).toHaveBeenCalledWith('lk', false);
  });

  it('there is no Killed heading when nothing was killed', () => {
    view();
    expect(screen.queryByTestId('brief-killed')).toBeNull();
  });

  // ---- the message — the thing the old form had nowhere to put ---------------------------------------

  it('shows the exact message as a message, inside "what to do with it"', () => {
    view();
    const out = within(screen.getByTestId('brief-section-output'));
    expect(out.getByTestId('message-text')).toHaveTextContent('Work (14) — two need a reply');
    expect(out.getByText(/sends you this on WhatsApp/i)).toBeTruthy();
  });

  it('an empty message says plainly that nothing useful can arrive', () => {
    view({ delivery: { whatsapp: true, telegram: false, messageText: '' } });
    expect(screen.getByTestId('message-empty')).toHaveTextContent(/nothing useful can arrive/i);
  });

  it('no message is shown when nothing is being sent', () => {
    view({ delivery: { whatsapp: false, telegram: false, messageText: '' } });
    expect(screen.queryByTestId('brief-message')).toBeNull();
  });

  it('the message can be rewritten', () => {
    const onEdit = vi.fn();
    render(<MessagePreview delivery={{ whatsapp: true, telegram: false, messageText: 'old' }} onEdit={onEdit} />);
    fireEvent.click(screen.getByTestId('message-edit'));
    fireEvent.change(screen.getByLabelText('The message it sends you'), { target: { value: 'Work (14)\nPersonal (9)' } });
    fireEvent.click(screen.getByTestId('message-save'));
    expect(onEdit).toHaveBeenCalledWith('Work (14)\nPersonal (9)');
  });

  // ---- proof ------------------------------------------------------------------------------------------

  it('a "looked" line offers to show what really came back', () => {
    const p = view();
    fireEvent.click(screen.getByTestId('line-proof'));
    expect(p.onProof).toHaveBeenCalledWith('tc1');
  });

  it('a line with no proof behind it offers nothing to open', () => {
    view({ sections: { ...brief().sections, sources: [{ id: 'l2', text: 'Gmail.', origin: 'ai' }] } });
    expect(screen.queryByTestId('line-proof')).toBeNull();
  });

  // ---- approving ---------------------------------------------------------------------------------------

  it('approve is offered, and says nothing is built yet', () => {
    const p = view();
    expect(screen.getByText(/You will still see it run once before anything is saved or sent/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('brief-approve'));
    expect(p.onApprove).toHaveBeenCalled();
  });

  it('an approved brief says what happens next instead of offering approve again', () => {
    view({ status: 'approved' });
    expect(screen.queryByTestId('brief-approve')).toBeNull();
    expect(screen.getByTestId('brief-approved')).toHaveTextContent(/see it run once before anything is saved/i);
  });

  // ---- adding -----------------------------------------------------------------------------------------

  it('a line he adds by hand is his', () => {
    const p = view();
    fireEvent.click(screen.getByTestId('add-line-success'));
    fireEvent.change(screen.getByLabelText('Add to What "it worked" means'), { target: { value: 'At least 20 mails.' } });
    fireEvent.click(screen.getByTestId('add-save-success'));
    expect(p.onAdd).toHaveBeenCalledWith('success', 'At least 20 mails.');
  });
});

describe('the tag on its own', () => {
  it('carries an icon as well as a colour, so it still reads without colour', () => {
    const { container } = render(<><OriginTag origin="ai" /><OriginTag origin="owner" /><OriginTag origin="tool" /></>);
    expect(container.querySelectorAll('svg').length).toBe(3);
  });
});
