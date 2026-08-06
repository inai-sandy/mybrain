import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemindersTab } from './Contacts';

/**
 * BEA-1287 — the /reminders page follows the list standard. Before this, the manage view rendered
 * every reminder (63 and growing) in one flat unsorted list with done ones mixed in, and the inbox
 * had no search at all.
 */

vi.mock('react-router-dom', async () => {
  const actual: any = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn(), useSearchParams: () => [new URLSearchParams(), vi.fn()] };
});
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));

const REM = (over: any) => ({
  id: over.id,
  contactId: 'c1',
  taskId: null,
  message: over.message || 'please send the report',
  count: 0,
  times: ['10:00'],
  status: 'active',
  createdAt: '2026-08-01T10:00:00Z',
  contact: { id: 'c1', name: over.person || 'Someone', whatsappNumber: '+91', notes: null, tags: [] },
  task: over.taskTitle ? { id: 't1', title: over.taskTitle } : null,
  ...over,
});

const REMINDERS = [
  REM({ id: 'r-done', person: 'Aaron Done', status: 'done', createdAt: '2026-08-03T10:00:00Z' }),
  REM({ id: 'r-stopped', person: 'Kiran Stopped', status: 'stopped', createdAt: '2026-08-03T11:00:00Z' }),
  REM({ id: 'r-paused', person: 'Priya Paused', status: 'paused', createdAt: '2026-08-02T10:00:00Z' }),
  REM({ id: 'r-active', person: 'Zoya Active', status: 'active', createdAt: '2026-08-01T10:00:00Z', taskTitle: 'Collect the invoices' }),
];

const CONVOS = [
  { contactId: 'c1', name: 'Ravi', whatsappNumber: '+91', lastMessage: { body: 'the units are packed', direction: 'in', at: '2026-08-05T10:00:00Z' }, lastAt: '2026-08-05T10:00:00Z', reminderId: 'r1', times: [], activeReminderCount: 1, needsOwner: false, unread: 2 },
  { contactId: 'c2', name: 'Meena', whatsappNumber: '+91', lastMessage: { body: 'will confirm tomorrow', direction: 'in', at: '2026-08-04T10:00:00Z' }, lastAt: '2026-08-04T10:00:00Z', reminderId: 'r2', times: [], activeReminderCount: 1, needsOwner: true, unread: 0 },
];

const SUGGESTIONS = Array.from({ length: 7 }, (_, i) => ({
  task: { id: `t${i}`, title: `Chase thing ${i + 1}`, party: `Person ${i + 1}` },
  contact: { id: `sc${i}`, name: `Person ${i + 1}`, whatsappNumber: '+91', notes: null, tags: [] },
  noNumber: false,
  hasActiveReminder: false,
}));

function mockFetch(over: { reminders?: any[]; convos?: any[]; suggestions?: any[] } = {}) {
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/reminders/conversations')) return { ok: true, json: async () => ({ conversations: over.convos ?? CONVOS }) };
    if (u.includes('/api/reminders/suggestions')) return { ok: true, json: async () => ({ suggestions: over.suggestions ?? [] }) };
    if (u.endsWith('/api/reminders')) return { ok: true, json: async () => ({ reminders: over.reminders ?? REMINDERS }) };
    return { ok: true, json: async () => ({}) };
  }) as any;
}

const openManage = async () => {
  render(<RemindersTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reminders' }));
};

beforeEach(() => mockFetch());
afterEach(() => vi.restoreAllMocks());

describe('the reminders list follows the list standard (BEA-1287)', () => {
  it('starts on Active + paused — done and stopped reminders stay one tap away, not in the way', async () => {
    await openManage();
    await waitFor(() => expect(screen.getByText('Zoya Active')).toBeTruthy());
    expect(screen.getByText('Priya Paused')).toBeTruthy();
    expect(screen.queryByText('Aaron Done')).toBeNull();
    expect(screen.queryByText('Kiran Stopped')).toBeNull();
    expect(screen.getByTestId('dt-count').textContent).toContain('2 results');
  });

  it('the Done + stopped filter brings BOTH finished kinds back — stopped is not a separate hiding place', async () => {
    // A chase whose task completes becomes 'stopped', not 'done'; the rest of the page already
    // treats them as one bucket, so the filter must too (review finding, BEA-1287).
    await openManage();
    await waitFor(() => expect(screen.getByText('Zoya Active')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'done' } });
    expect(screen.getByText('Aaron Done')).toBeTruthy();
    expect(screen.getByText('Kiran Stopped')).toBeTruthy();
    expect(screen.queryByText('Zoya Active')).toBeNull();
  });

  it('sorts active before paused by default', async () => {
    await openManage();
    await waitFor(() => expect(screen.getByText('Zoya Active')).toBeTruthy());
    const names = screen.getAllByText(/Zoya Active|Priya Paused/).map((n) => n.textContent);
    expect(names.indexOf('Zoya Active')).toBeLessThan(names.indexOf('Priya Paused'));
  });

  it('search reaches the person, the message AND the task title', async () => {
    await openManage();
    await waitFor(() => expect(screen.getByText('Zoya Active')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'invoices' } });
    expect(screen.getByText('Zoya Active')).toBeTruthy();
    expect(screen.queryByText('Priya Paused')).toBeNull();
  });

  it('every card keeps its actions — chat, edit, pause, delete', async () => {
    await openManage();
    await waitFor(() => expect(screen.getByText('Zoya Active')).toBeTruthy());
    expect(screen.getAllByTitle('Open chat').length).toBe(2);
    expect(screen.getAllByTitle('Pause').length).toBe(1); // active only
    expect(screen.getAllByTitle('Resume').length).toBe(1); // paused only
    expect(screen.getAllByTitle('Delete').length).toBe(2);
  });
});

describe('the chats inbox gets search and chips, and stays an inbox (BEA-1287)', () => {
  it('shows the chips with counts and the total', async () => {
    render(<RemindersTab />);
    await waitFor(() => expect(screen.getByText('Ravi')).toBeTruthy());
    expect(screen.getByText('All · 2')).toBeTruthy();
    expect(screen.getByText('Unread · 1')).toBeTruthy();
    expect(screen.getByText('Needs you · 1')).toBeTruthy();
    expect(screen.getByTestId('chats-count').textContent).toBe('2 chats');
  });

  it('search matches the name and the last message', async () => {
    render(<RemindersTab />);
    await waitFor(() => expect(screen.getByText('Ravi')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'confirm tomorrow' } });
    expect(screen.getByText('Meena')).toBeTruthy();
    expect(screen.queryByText('Ravi')).toBeNull();
    expect(screen.getByTestId('chats-count').textContent).toBe('1 chat');
  });

  it('the Unread chip narrows to unread chats, and a no-match says so honestly', async () => {
    render(<RemindersTab />);
    await waitFor(() => expect(screen.getByText('Ravi')).toBeTruthy());
    fireEvent.click(screen.getByText('Unread · 1'));
    expect(screen.getByText('Ravi')).toBeTruthy();
    expect(screen.queryByText('Meena')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No chats match/)).toBeTruthy();
  });
});

describe('suggestions stop hogging the screen (BEA-1287)', () => {
  it('shows the first 5 with the rest behind one tap', async () => {
    mockFetch({ suggestions: SUGGESTIONS });
    await openManage();
    await waitFor(() => expect(screen.getByText('Chase thing 1')).toBeTruthy());
    expect(screen.getByText('Chase thing 5')).toBeTruthy();
    expect(screen.queryByText('Chase thing 6')).toBeNull();
    fireEvent.click(screen.getByText('Show 2 more'));
    expect(screen.getByText('Chase thing 7')).toBeTruthy();
    fireEvent.click(screen.getByText('Show fewer'));
    expect(screen.queryByText('Chase thing 6')).toBeNull();
  });
});
