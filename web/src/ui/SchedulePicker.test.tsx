import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SchedulePicker, dayName, schedSentence, schedText } from './SchedulePicker';

/**
 * BEA-1359 — a weekly schedule names its day. "Every Monday 08:00" is what the owner's Instagram
 * digest runs on; before this the picker could only say Sunday (`dow: 0`), and every weekly job
 * saved by it carries `dow: 0`; a schedule with no `dow` fires on Monday (`s.dow ?? 1` in the scheduler) and is named so.
 */
describe('SchedulePicker — weekly on a chosen day', () => {
  afterEach(() => cleanup());

  it('says the day in the sentence, Sunday when none is stored', () => {
    expect(schedText({ every: 'week', dow: 1, at: '08:00' })).toBe('Every Monday at 08:00');
    expect(schedSentence({ every: 'week', dow: 1, at: '08:00' })).toBe('Runs every Monday at 08:00.');
    expect(schedText({ every: 'week', at: '08:00' })).toBe('Every Monday at 08:00'); // no dow = Monday — the scheduler's own default (`s.dow ?? 1`)
    expect(dayName(6)).toBe('Saturday');
    expect(dayName(9)).toBe('Monday'); // never a crash on a bad value
  });

  it('picking "Every week on…" shows a day select; choosing Monday stores {every:week, dow:1, at}', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SchedulePicker value={null} onChange={onChange} />);
    fireEvent.change(screen.getByDisplayValue('Only when I press Run'), { target: { value: 'week' } });
    expect(onChange).toHaveBeenLastCalledWith({ every: 'week', dow: 0, at: '07:00' });
    rerender(<SchedulePicker value={{ every: 'week', dow: 0, at: '08:00' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Day of the week'), { target: { value: '1' } });
    expect(onChange).toHaveBeenLastCalledWith({ every: 'week', dow: 1, at: '08:00' });
    rerender(<SchedulePicker value={{ every: 'week', dow: 1, at: '08:00' }} onChange={onChange} />);
    expect(screen.getByText('Runs every Monday at 08:00.')).toBeTruthy();
    // changing the time keeps the day
    fireEvent.change(screen.getByDisplayValue('08:00'), { target: { value: '09:30' } });
    expect(onChange).toHaveBeenLastCalledWith({ every: 'week', dow: 1, at: '09:30' });
  });
});
