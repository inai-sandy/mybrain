import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkerRow, workerSummary, costLine, type WorkerState } from './AgentWorkerRow';

/**
 * The Worker row (BEA-1394, agent workers 9/10 — `specs/AGENT-WORKERS.md` §J).
 *
 * What it must get right, in the owner's terms:
 *  • the version, when it was built and whether its tests passed;
 *  • the switch — off by default, and it is the ONLY thing that turns the worker road on;
 *  • what the NEXT run will do, in the server's words (never the page's own guess);
 *  • staleness with Rebuild, the repair history, the held-repair decision, and the last run's cost.
 */

const BUILT = '2026-08-22T09:00:00.000Z';

function state(over: Partial<WorkerState> = {}): WorkerState {
  return {
    agentId: 'ag1',
    worker: { id: 'b3', version: 3, status: 'promoted', origin: 'rebuild', tests: { passed: 8, failed: 0 }, startedAt: BUILT, finishedAt: BUILT },
    stale: false,
    compilable: true,
    building: false,
    builds: [
      { id: 'b3', version: 3, status: 'promoted', origin: 'rebuild', tests: { passed: 8, failed: 0 }, startedAt: BUILT, finishedAt: BUILT },
      { id: 'b2', version: 2, status: 'failed', origin: 'repair', cause: 'a link column went missing', error: 'Only 0 of 3 rows have a link', startedAt: BUILT },
      { id: 'b1', version: 1, status: 'promoted', origin: 'build', tests: { passed: 5, failed: 0 }, startedAt: BUILT },
    ],
    useWorker: false,
    road: { use: false },
    lastRun: { id: 'r1', status: 'done', runKind: 'plan', startedAt: BUILT, cost: { credits: 12, aiTokens: 12_500, calls: 4 } },
    ...over,
  };
}

function mount(s: WorkerState | null, reload = vi.fn(async () => s)) {
  const toast = vi.fn();
  render(<WorkerRow agentId="ag1" worker={s} contractWords={['It must find at least 1 row.']} reload={reload} toast={toast} />);
  return { toast, reload };
}

afterEach(() => cleanup());

describe('the closed row says it in one line', () => {
  it('version, build day, tests and which road it is on', () => {
    expect(workerSummary(state())).toMatch(/^v3 · built .+ · 8 tests passed · running the old way$/);
    expect(workerSummary(state({ useWorker: true, road: { use: true, version: 3 } }))).toMatch(/running its worker$/);
    expect(workerSummary(state({ useWorker: true, stale: true, road: { use: false, say: 'x' } }))).toMatch(/out of date · falling back to the old way$/);
  });
  it('the honest words when there is nothing yet', () => {
    expect(workerSummary(null)).toBe('Checking…');
    expect(workerSummary(state({ worker: null }))).toBe('No worker yet · runs the old way');
    expect(workerSummary(state({ building: true }))).toBe('Building a worker now…');
    expect(workerSummary(state({ compilable: false }))).toBe('Not for this job — it runs on the engine');
  });
  it('costLine says credits and AI tokens, and "no AI cost" when there was none', () => {
    expect(costLine({ credits: 12, aiTokens: 12_500, calls: 4 })).toBe('12 credits · 13k AI tokens · 4 calls');
    expect(costLine({ credits: 1, aiTokens: 0, calls: 1 })).toBe('1 credit · no AI cost · 1 call');
    expect(costLine(null)).toBe('nothing recorded');
  });
});

describe('the open row', () => {
  it('shows the live version, its tests, the contract and what the last run cost', () => {
    mount(state());
    expect(screen.getByTestId('worker-version')).toHaveTextContent('Worker v3');
    expect(screen.getByTestId('worker-tests')).toHaveTextContent('8 passed');
    expect(screen.getByTestId('worker-contract')).toHaveTextContent('It must find at least 1 row.');
    expect(screen.getByTestId('worker-last-cost')).toHaveTextContent('12 credits · 13k AI tokens · 4 calls');
    expect(screen.getByTestId('worker-last-cost')).toHaveTextContent('the old way');
  });

  it('the switch is OFF and turning it on PATCHes the job — nothing else ever does', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    (globalThis as any).fetch = fetchMock;
    const { toast } = mount(state());
    const sw = screen.getByTestId('worker-use') as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe('/api/agent/agents/ag1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ useWorker: true });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('success', expect.stringMatching(/on its worker/)));
  });

  it('with no worker built the switch cannot be turned on, and it says why', () => {
    mount(state({ worker: null, builds: [] }));
    expect((screen.getByTestId('worker-use') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('worker-none')).toHaveTextContent('runs the old way');
    expect(screen.getByText(/Build a worker first/)).toBeTruthy();
  });

  it('ON: the road line is the SERVER’s sentence, never the page’s guess', () => {
    mount(state({ useWorker: true, stale: true, road: { use: false, say: 'Ran it the old way — the plan changed since worker v3 was built.' } }));
    expect(screen.getByTestId('worker-road')).toHaveTextContent('the plan changed since worker v3 was built');
    expect(screen.getByTestId('worker-stale')).toHaveTextContent('out of date');
    cleanup();
    mount(state({ useWorker: true, road: { use: true, version: 3 } }));
    expect(screen.getByTestId('worker-road')).toHaveTextContent('Next run: on worker v3.');
  });

  /**
   * "Your worker predates the tools, and nothing tells you" (BEA-1461).
   *
   * The owner's email agent sat on a v1 worker built the day before the tools were opened, and every
   * signal on this screen stayed silent: the plan had not changed (so not stale) and the kit MAJOR
   * had not moved (the change was additive). It read as perfectly current while having none of the
   * new doors, and the only way to know was to remember.
   */
  it('says when a worker predates tools that were added since', () => {
    mount(state({ partsBoxOld: true, partsBoxNote: 'This worker was built before the tools were opened up, so it cannot call anything outside its own plan, and it never sees what a service really answers. Rebuild it to give it the full set — the plan is unchanged, so nothing else about the job moves.' }));
    const note = screen.getByTestId('worker-parts-box');
    expect(note).toHaveTextContent('built before the tools were opened up');
    // The reassurance is half the message: he must not think his job changed under him.
    expect(note).toHaveTextContent('the plan is unchanged');
    // It is the SERVER's sentence, never a second copy written here.
    expect(note).not.toHaveTextContent('out of date');
  });

  it('says nothing when the worker is on the current parts box', () => {
    mount(state({ partsBoxOld: false }));
    expect(screen.queryByTestId('worker-parts-box')).toBeNull();
  });

  it('a STALE worker wins — he is not told two different things at once', () => {
    // Stale means "the plan changed, this program no longer does what the job says" and is the more
    // serious of the two. Showing both would bury it under a milder, bluer sentence.
    mount(state({ stale: true, partsBoxOld: true, partsBoxNote: 'older parts box' }));
    expect(screen.getByTestId('worker-stale')).toBeTruthy();
    expect(screen.queryByTestId('worker-parts-box')).toBeNull();
  });

  it('a held repair offers the owner the decision, and only him', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    (globalThis as any).fetch = fetchMock;
    mount(state({ held: { id: 'b4', version: 4, status: 'held', origin: 'repair', error: 'It returns 4 rows where v3 returned 9.', startedAt: BUILT } }));
    expect(screen.getByTestId('worker-held')).toHaveTextContent('was NOT put live');
    fireEvent.click(screen.getByText('Put it live'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/agent/agents/ag1/worker/repairs/b4/accept', { method: 'POST' }));
  });

  it('the history is counted, capped and expandable — repairs say what broke', () => {
    mount(state());
    expect(screen.getByText(/Builds and repairs/).textContent).toMatch(/\(3, 1 repair\)/);
    expect(screen.getByTestId('worker-history')).toHaveTextContent('what broke: a link column went missing');
  });

  it('Rebuild posts the build and says a build changes nothing until its tests pass', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ agentId: 'ag1', built: { ok: true, version: 4, tests: { passed: 9 } } }) }));
    (globalThis as any).fetch = fetchMock;
    const { toast } = mount(state());
    expect(screen.getByTestId('worker-build')).toHaveTextContent('Rebuild');
    fireEvent.click(screen.getByTestId('worker-build'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/agent/agents/ag1/worker/build', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('success', expect.stringMatching(/v4 is live/)));
  });

  it('an engine job says so instead of offering a dead button', () => {
    mount(state({ compilable: false, reason: 'This job runs on the engine, not on a plan of sources.' }));
    expect(screen.getByTestId('worker-not-compilable')).toHaveTextContent('runs on the engine');
    expect(screen.queryByTestId('worker-build')).toBeNull();
  });
});

/**
 * PUT AN OLDER VERSION BACK (BEA-1506).
 *
 * The rollback route has existed since BEA-1494 and nothing called it, so when his email agent
 * regressed from v6 to v8 the only way to restore the working version was a terminal — twice.
 */
describe('rolling back to a version that worked', () => {
  const state = (over: any = {}): any => ({
    agentId: 'job-1',
    worker: { id: 'b8', version: 8, status: 'promoted', tests: { passed: 8, failed: 0 } },
    held: null,
    builds: [
      { id: 'b8', version: 8, status: 'promoted', origin: 'rebuild' },
      { id: 'b6', version: 6, status: 'promoted', origin: 'build' },
      { id: 'b7', version: 7, status: 'failed', origin: 'rebuild' },
    ],
    building: false,
    repairing: false,
    // Without this the panel short-circuits to "this job runs on the engine" and renders no history.
    compilable: true,
    ...over,
  });

  it('offers an earlier version that really was built', () => {
    render(<WorkerRow agentId="job-1" worker={state()} contractWords={[]} reload={() => {}} toast={() => {}} />);
    expect(screen.getByTestId('rollback-v6')).toBeTruthy();
  });

  it('does NOT offer the version that is already live', () => {
    // "Put v8 back" when v8 is live is a no-op dressed up as a choice.
    render(<WorkerRow agentId="job-1" worker={state()} contractWords={[]} reload={() => {}} toast={() => {}} />);
    expect(screen.queryByTestId('rollback-v8')).toBeNull();
  });

  it('does NOT offer a version that never passed', () => {
    render(<WorkerRow agentId="job-1" worker={state()} contractWords={[]} reload={() => {}} toast={() => {}} />);
    expect(screen.queryByTestId('rollback-v7')).toBeNull();
  });
});
