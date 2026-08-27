import { OwnerAskService } from './owner-ask.service';

/**
 * EVERY LISTENER HEARS THE ANSWER (BEA-1505).
 *
 * `setAnswerWatcher` was one slot — `this.watcher = fn` — and two services claimed it: the old brief
 * road and the new goal road. Whichever booted last silently erased the other, and nothing anywhere
 * said so.
 *
 * The goal road lost. So when he replied **"Keep it"** on WhatsApp, the code that switches the agent
 * on and finishes the run never ran: two agents he had kept stayed switched off, and twenty minutes
 * later the stall watchdog marked a run that had already saved his document as **failed**.
 */
describe('answering a question reaches everyone who is listening', () => {
  function world() {
    let hook: any = null;
    const agent: any = { setAnswerHook: (h: any) => { hook = h; } };
    const gates: any = { settlePending: async () => undefined };
    const svc: any = new OwnerAskService(agent, undefined, gates);
    svc.onModuleInit?.();
    return { svc, fire: (runId: string, answer: string) => hook(runId, answer) };
  }

  it('calls BOTH listeners, not just the last one to register', async () => {
    const w = world();
    const heard: string[] = [];
    w.svc.setAnswerWatcher(() => { heard.push('brief'); });
    w.svc.setAnswerWatcher(() => { heard.push('goal'); });

    await w.fire('run-1', 'Keep it');

    expect(heard).toEqual(['brief', 'goal']);
  });

  it('one listener throwing does not stop the others hearing it', async () => {
    // The whole point of calling them separately. A brief-road failure must not silently cost him
    // the goal road, which is what switches his agent on.
    const w = world();
    const heard: string[] = [];
    w.svc.setAnswerWatcher(() => { throw new Error('this one is broken'); });
    w.svc.setAnswerWatcher(() => { heard.push('goal'); });

    await expect(w.fire('run-1', 'Keep it')).resolves.not.toThrow();
    expect(heard).toEqual(['goal']);
  });

  it('registering the same listener twice does not call it twice', async () => {
    const w = world();
    let n = 0;
    const fn = () => { n++; };
    w.svc.setAnswerWatcher(fn);
    w.svc.setAnswerWatcher(fn);
    await w.fire('run-1', 'Keep it');
    expect(n).toBe(1);
  });

  it('ignores a non-function, rather than blowing up at answer time', async () => {
    const w = world();
    w.svc.setAnswerWatcher(undefined as any);
    await expect(w.fire('run-1', 'Keep it')).resolves.not.toThrow();
  });
});
