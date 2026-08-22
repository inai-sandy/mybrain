import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { GmailUsageLine } from './GmailUsageLine';

/**
 * BEA-1399 — the owner can SEE how many Gmail calls the day used against the cap, and when the next
 * scheduled read is; in Settings he can change the cap. Every number comes from the server.
 */
afterEach(() => cleanup());

const USAGE = { day: '2026-08-22', tz: 'Asia/Kolkata', calls: 3, cap: 60, byAction: [{ action: 'fetch_emails', n: 2 }, { action: 'get_profile', n: 1 }], last: '2026-08-22T15:30:00.000Z', schedule: { early: '21:00', final: '23:30' }, next: { time: '21:00', day: 'today' } };

describe('GmailUsageLine (BEA-1399)', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url: any, init?: any) => {
      if (String(url).endsWith('/api/google/gmail/usage')) return { ok: true, json: async () => USAGE } as any;
      if (String(url).endsWith('/api/google/gmail/cap') && init?.method === 'PUT') return { ok: true, json: async () => ({ cap: JSON.parse(init.body).cap }) } as any;
      return { ok: false, json: async () => ({}) } as any;
    }) as any;
  });

  it('shows calls today against the cap, what they were, and the next scheduled read', async () => {
    render(<GmailUsageLine />);
    const line = await screen.findByTestId('gmail-usage');
    expect(line.textContent).toMatch(/Gmail calls today:?\s*3\s*\/\s*60/);
    expect(line.textContent).toMatch(/next read 21:00 today/i);
    expect(line.textContent).toMatch(/21:00.*23:30/);
  });

  it('in Settings the cap is editable and saved to the server; 0 reads as "no cap"', async () => {
    render(<GmailUsageLine editable />);
    const input = (await screen.findByLabelText(/daily cap/i)) as HTMLInputElement;
    expect(input.value).toBe('60');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect((global.fetch as any).mock.calls.some((c: any[]) => String(c[0]).endsWith('/api/google/gmail/cap') && c[1]?.method === 'PUT' && JSON.parse(c[1].body).cap === 100)).toBe(true));
    await waitFor(() => expect(screen.getByTestId('gmail-usage').textContent).toMatch(/3\s*\/\s*100/));
  });

  it('draws nothing when the server has no usage to report (Gmail not connected / old server)', async () => {
    (global.fetch as any) = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    const { container } = render(<GmailUsageLine />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });
});
