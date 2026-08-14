import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TaskDetail } from './TaskDetail';

/**
 * BEA-1315 — the job page can be acted on, not just read.
 *
 * BEA-1310 put the whole picture on one page and left it read-only: you could see that the chase was
 * still running and that Deepthi said it was done three days ago, and could do nothing about either
 * without leaving for another screen.
 *
 * What these tests really guard is the *door*. Every action must post to the endpoint the other
 * screens already use, because a second way to finish a job is exactly how "done here" stops meaning
 * "done there" — which was the original complaint. So they assert the URL and the body, not that a
 * button exists.
 */

vi.mock('react-router-dom', async () => {
  const actual: any = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn(), useParams: () => ({ id: 't1' }) };
});
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));

const JOB = (over: any = {}) => ({
  id: 't1',
  title: 'Place PCBs for the Elleys order',
  status: 'open',
  kind: 'assignment',
  createdAt: '2026-08-01T09:00:00Z',
  owner: { id: 'deepthi', name: 'Deepthi' },
  chases: [{ id: 'r1', status: 'active', repeat: 'daily', times: ['10:00', '17:30'], createdAt: '2026-08-01T09:00:00Z', contact: { id: 'deepthi', name: 'Deepthi' } }],
  claims: [],
  handovers: [],
  days: [],
  messages: [],
  ...over,
});

/** Every fetch this page makes, in order. `calls[0]` is always the initial read. */
let calls: { url: string; init?: any }[] = [];

function mount(job: any = JOB()) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init });
    return { ok: true, json: async () => job } as any;
  }));
  return render(<TaskDetail />, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });
}

/** The calls this page made that were not the initial read. */
const actions = () => calls.slice(1);
const body = (i = 0) => JSON.parse(actions()[i]?.init?.body || '{}');

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('acting on the job itself (BEA-1315)', () => {
  it('closing it as not done sends the REASON you typed, not a canned one', async () => {
    // The reason is the whole value of the record: "Radha left the organisation" is what makes the
    // ending readable a month later. The tasks board sends a hardcoded "not doing this".
    mount();
    await screen.findByText(/Place PCBs/);
    fireEvent.click(screen.getByText('Not doing it'));
    fireEvent.change(await screen.findByLabelText(/Why\?/), { target: { value: 'Elleys cancelled the order' } });
    fireEvent.click(screen.getByText('Close it'));
    await waitFor(() => expect(actions()).toHaveLength(2)); // the drop, then the re-read
    expect(actions()[0].url).toBe('/api/tasks/t1/drop');
    expect(body(0)).toEqual({ reason: 'Elleys cancelled the order' });
  });

  it('and sends no reason at all rather than an empty one when you skip it', async () => {
    mount();
    await screen.findByText(/Place PCBs/);
    fireEvent.click(screen.getByText('Not doing it'));
    fireEvent.click(await screen.findByText('Close it'));
    await waitFor(() => expect(actions().length).toBeGreaterThan(0));
    expect(body(0)).toEqual({});
  });

  it('re-opening a DROPPED job uses the door that actually clears the drop', async () => {
    // `PUT /tasks/:id` does not accept a status at all, so the obvious-looking call would have
    // returned 200 and changed nothing. `:id/done` with done:false clears droppedAt and restarts
    // the chase, which is what re-opening has to mean. (self-caught while wiring)
    mount(JOB({ status: 'dropped', droppedAt: '2026-08-10T10:00:00Z', droppedReason: 'Radha left' }));
    fireEvent.click(await screen.findByText('Open it again'));
    await waitFor(() => expect(actions().length).toBeGreaterThan(0));
    expect(actions()[0].url).toBe('/api/tasks/t1/done');
    expect(body(0)).toEqual({ done: false });
  });

  it('deleting asks first, and says what is lost against the gentler option', async () => {
    mount();
    await screen.findByText(/Place PCBs/);
    fireEvent.click(screen.getByLabelText('Delete this job'));
    expect(await screen.findByText(/Delete this job\?/)).toBeTruthy();
    expect(screen.getByText(/Closing it as not done keeps all of that/)).toBeTruthy();
    expect(actions()).toHaveLength(0); // nothing sent until it is confirmed
  });

  it('and only then does it delete', async () => {
    mount();
    await screen.findByText(/Place PCBs/);
    fireEvent.click(screen.getByLabelText('Delete this job'));
    fireEvent.click(await screen.findByText(/^Delete$/, { selector: 'button.bg-red-600' }));
    await waitFor(() => expect(actions().length).toBeGreaterThan(0));
    expect(actions()[0]).toMatchObject({ url: '/api/tasks/t1', init: { method: 'DELETE' } });
  });

  it('a finished job offers re-opening, never a second "mark done"', async () => {
    mount(JOB({ status: 'done', completedAt: '2026-08-09T10:00:00Z' }));
    await screen.findByText('Open it again');
    expect(screen.queryByText('Mark done')).toBeNull();
    expect(screen.queryByText('Not doing it')).toBeNull();
  });
});

describe('a daily report is not a job that finishes (BEA-1315)', () => {
  const REPORT = JOB({ kind: 'recurring', title: 'Send daily Haasya production update by 7PM' });

  it('is never offered "Mark done" — it is satisfied day by day, never completed', async () => {
    // The delegated and stalling lists both exclude recurring work for exactly this reason. Offering
    // to finish a standing arrangement contradicts the rest of the app. (BEA-1117/1123, self-caught
    // while looking at Karthik's daily update page)
    mount(REPORT);
    await screen.findByText(/Send daily Haasya/);
    expect(screen.queryByText('Mark done')).toBeNull();
    expect(screen.getByText('Stop this report')).toBeTruthy();
  });

  it('an ordinary job still is', async () => {
    mount();
    await screen.findByText(/Place PCBs/);
    expect(screen.getByText('Mark done')).toBeTruthy();
    expect(screen.queryByText('Stop this report')).toBeNull();
  });

  it('stopping one talks about the arrangement, not about failing', async () => {
    mount(REPORT);
    fireEvent.click(await screen.findByText('Stop this report'));
    expect(await screen.findByText(/Stop this daily report\?/)).toBeTruthy();
    expect(screen.getByText(/Every day already sent stays in the record/)).toBeTruthy();
    expect(screen.queryByText(/never counted as finished/)).toBeNull();
  });
});

describe('answering a claim from here (BEA-1315)', () => {
  const WAITING = JOB({
    claims: [{ id: 'c1', quote: 'placed today sir', status: 'pending', source: 'whatsapp', createdAt: '2026-08-12T10:00:00Z', by: 'Deepthi' }],
  });

  it('shows their exact words, and whose they were', async () => {
    mount(WAITING);
    expect(await screen.findByText(/Deepthi say it is done/)).toBeTruthy();
    // it appears in the claim card and again in the story below it
    expect(screen.getAllByText(/placed today sir/).length).toBeGreaterThan(0);
  });

  it('"yes" goes through the SAME door as the review inbox', async () => {
    // Not a shortcut that marks the task done directly: that would settle the task and leave the
    // claim pending for ever, which is the drift this whole run exists to stop.
    mount(WAITING);
    fireEvent.click(await screen.findByText('Yes, it is done'));
    await waitFor(() => expect(actions().length).toBeGreaterThan(0));
    expect(actions()[0].url).toBe('/api/tasks/claims/c1/decide');
    expect(body(0)).toEqual({ confirm: true });
  });

  it('"no" rejects the claim, which is what puts the chase back on', async () => {
    mount(WAITING);
    fireEvent.click(await screen.findByText('No, not yet'));
    await waitFor(() => expect(actions().length).toBeGreaterThan(0));
    expect(body(0)).toEqual({ confirm: false });
  });

  it('a claim already settled is not asked about again', async () => {
    mount(JOB({ claims: [{ id: 'c1', quote: 'done', status: 'confirmed', source: 'whatsapp', createdAt: '2026-08-12T10:00:00Z', decidedAt: '2026-08-12T11:00:00Z', by: 'Deepthi' }] }));
    await screen.findByText(/Place PCBs/);
    expect(screen.queryByText('Yes, it is done')).toBeNull();
  });
});

describe('acting on the chase (BEA-1315)', () => {
  it('pauses it, and says plainly that the messages stop', async () => {
    mount();
    fireEvent.click(await screen.findByText('Pause'));
    await waitFor(() => expect(actions().length).toBeGreaterThan(0));
    expect(actions()[0]).toMatchObject({ url: '/api/reminders/r1/pause', init: { method: 'POST' } });
  });

  it('offers Resume instead once it is paused', async () => {
    mount(JOB({ chases: [{ id: 'r1', status: 'paused', repeat: 'daily', times: ['10:00'], createdAt: '2026-08-01T09:00:00Z' }] }));
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(actions().length).toBeGreaterThan(0));
    expect(actions()[0].url).toBe('/api/reminders/r1/resume');
    expect(screen.queryByText('Pause')).toBeNull();
  });

  it('stopping confirms first and promises the job survives', async () => {
    mount();
    fireEvent.click(await screen.findByText('Stop'));
    expect(await screen.findByText(/Stop this chase\?/)).toBeTruthy();
    expect(screen.getByText(/The job stays open/)).toBeTruthy();
    expect(actions()).toHaveLength(0);
  });

  it('deleting the chase confirms, promises the job survives, and hits the chase door', async () => {
    // The one destructive action on this page that had no test. (review finding)
    mount();
    fireEvent.click(await screen.findByLabelText('Delete this chase'));
    expect(await screen.findByText(/Delete this chase\?/)).toBeTruthy();
    expect(screen.getByText(/The job itself stays exactly as it is/)).toBeTruthy();
    expect(actions()).toHaveLength(0);
    fireEvent.click(screen.getByText(/^Delete$/, { selector: 'button.bg-red-600' }));
    await waitFor(() => expect(actions().length).toBeGreaterThan(0));
    expect(actions()[0]).toMatchObject({ url: '/api/reminders/r1', init: { method: 'DELETE' } });
  });

  it('a stopped chase offers neither pause nor resume, only delete', async () => {
    mount(JOB({ chases: [{ id: 'r1', status: 'stopped', repeat: 'daily', times: [], createdAt: '2026-08-01T09:00:00Z' }] }));
    await screen.findByText('The chase');
    expect(screen.queryByText('Pause')).toBeNull();
    expect(screen.queryByText('Resume')).toBeNull();
    expect(screen.queryByText('Stop')).toBeNull();
  });
});

describe('the two kinds of quiet chase read differently (BEA-1317)', () => {
  it('one the app paused says they claim it is done', async () => {
    mount(JOB({ chases: [{ id: 'r1', status: 'paused', repeat: 'daily', times: ['10:00'], createdAt: '2026-08-01T09:00:00Z', pausedAuto: true }] }));
    expect(await screen.findByText(/they say it.s done/i)).toBeTruthy();
  });

  it('one HE paused says so, instead of putting words in their mouth', async () => {
    // Both were captioned "paused — they say it's done". On a chase he switched off himself that is
    // simply untrue, and it matters more now that his own pause survives the work being finished.
    mount(JOB({ chases: [{ id: 'r1', status: 'paused', repeat: 'daily', times: ['10:00'], createdAt: '2026-08-01T09:00:00Z', pausedAuto: false }] }));
    expect(await screen.findByText('paused by you')).toBeTruthy();
    expect(screen.queryByText(/they say it.s done/i)).toBeNull();
  });
});

describe('undoing a handover (BEA-1315)', () => {
  const HANDED = JOB({
    owner: { id: 'deepthi', name: 'Deepthi' },
    handovers: [
      { id: 'h1', from: 'Radha', to: 'Suresh', at: '2026-08-05T10:00:00Z' },
      { id: 'h2', from: 'Suresh', to: 'Deepthi', at: '2026-08-08T10:00:00Z' },
    ],
  });

  it('names the LAST handover, not the first', async () => {
    mount(HANDED);
    fireEvent.click(await screen.findByText('Undo the handover'));
    expect(await screen.findByText(/goes back to Suresh/)).toBeTruthy();
  });

  it('and gives it back through the existing door', async () => {
    mount(HANDED);
    fireEvent.click(await screen.findByText('Undo the handover'));
    fireEvent.click(await screen.findByText('Give it back'));
    await waitFor(() => expect(actions().length).toBeGreaterThan(0));
    expect(actions()[0]).toMatchObject({ url: '/api/tasks/t1/hand-back', init: { method: 'POST' } });
  });

  it('is not offered on work that has already ended', async () => {
    mount(JOB({ status: 'done', handovers: [{ id: 'h1', from: 'Radha', to: 'Deepthi', at: '2026-08-05T10:00:00Z' }] }));
    await screen.findByText('Open it again');
    expect(screen.queryByText('Undo the handover')).toBeNull();
  });
});

describe('deleting one message (BEA-1315)', () => {
  const CHATTY = JOB({ messages: [{ id: 'm1', direction: 'in', body: 'placed today sir', createdAt: '2026-08-12T10:00:00Z', by: 'Deepthi' }] });

  it('promises the work behind it is untouched — and it is, because it is a different endpoint', async () => {
    mount(CHATTY);
    fireEvent.click(await screen.findByLabelText('Delete this message'));
    expect(await screen.findByText(/Delete this message\?/)).toBeTruthy();
    expect(screen.getByText(/The job, its chase and anything claimed about it stay/)).toBeTruthy();
    fireEvent.click(screen.getByText(/^Delete$/, { selector: 'button.bg-red-600' }));
    await waitFor(() => expect(actions().length).toBeGreaterThan(0));
    expect(actions()[0]).toMatchObject({ url: '/api/reminders/messages/m1', init: { method: 'DELETE' } });
  });

  it('the delete is visible without hovering, because a phone cannot hover', async () => {
    // The same mistake as BEA-1309's first pass: `opacity-0 group-hover:` reads fine on a laptop and
    // is simply invisible on the device he actually uses.
    mount(CHATTY);
    const btn = await screen.findByLabelText('Delete this message');
    expect(btn.className).toContain('opacity-60');
    expect(btn.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
  });
});

describe('a slow request cannot be sent twice (BEA-1315)', () => {
  it('the confirm button goes dead while the delete is in flight', async () => {
    // It stayed live during the request, so a quick double-tap on a delete sent two deletes.
    // (review finding)
    calls = [];
    let release: (v: any) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      if (calls.length === 1) return { ok: true, json: async () => JOB() } as any;
      await new Promise((r) => { release = r; });
      return { ok: true, json: async () => ({}) } as any;
    }));
    render(<TaskDetail />, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });
    fireEvent.click(await screen.findByLabelText('Delete this job'));
    const go = await screen.findByText(/^Delete$/, { selector: 'button.bg-red-600' });
    fireEvent.click(go);
    await waitFor(() => expect(calls.length).toBe(2));
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(go); // the second tap
    fireEvent.click(go); // and a third
    expect(calls.length).toBe(2); // still just the one delete
    release({});
  });
});

describe('the page stays honest after an action (BEA-1315)', () => {
  it('re-reads the whole job rather than patching the screen', async () => {
    // Finishing a job also settles its claim, stops its chase and closes the team update. A
    // hand-patched screen would show one of those and not the others — which is the exact class of
    // bug this run is about.
    mount();
    fireEvent.click(await screen.findByText('Pause'));
    await waitFor(() => expect(calls.length).toBe(3)); // read, pause, read again
    expect(calls[2].url).toBe('/api/tasks/t1');
    expect(calls[2].init?.method).toBeUndefined();
  });

  it('a failed action says so and does NOT claim success', async () => {
    calls = [];
    let first = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      if (first) { first = false; return { ok: true, json: async () => JOB() } as any; }
      return { ok: false, json: async () => ({ message: 'nope' }) } as any;
    }));
    render(<TaskDetail />, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });
    fireEvent.click(await screen.findByText('Pause'));
    await waitFor(() => expect(calls.length).toBe(2));
    // No re-read: a failure must not look like it worked.
    expect(calls).toHaveLength(2);
  });
});
