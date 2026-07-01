import { EngineWatchdog } from './engine-watchdog.service';

// Repointed to the direct Codex runner in F5 (BEA-663): the watchdog now pings codex-runner /status
// and records health; it no longer auto-restarts (the Hermes helper-restart was removed).
describe('EngineWatchdog (direct Codex)', () => {
  const fakeAgent = () => ({ recorded: [] as any[], recordEngineHealth: jest.fn(async function (this: any, p: any) { this.recorded.push(p); }) });

  it('records healthy when the runner reports ready', async () => {
    const agent = fakeAgent();
    const orig = (global as any).fetch;
    (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ready: true }) }));
    try {
      const wd = new EngineWatchdog(agent as any);
      await (wd as any).tick();
      expect(agent.recordEngineHealth).toHaveBeenCalledWith(expect.objectContaining({ error: null }));
    } finally { (global as any).fetch = orig; }
  });

  it('records an error when the runner is unreachable (and does not throw / restart)', async () => {
    const agent = fakeAgent();
    const orig = (global as any).fetch;
    (global as any).fetch = jest.fn(async () => { throw new Error('down'); });
    try {
      const wd = new EngineWatchdog(agent as any);
      await (wd as any).tick();
      expect(agent.recordEngineHealth).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('unreachable') }));
    } finally { (global as any).fetch = orig; }
  });
});
