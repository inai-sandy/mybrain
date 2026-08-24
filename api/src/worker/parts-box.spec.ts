import { partsBox } from './worker-build.service';

/**
 * "Your worker predates the tools, and nothing tells you" (BEA-1461).
 *
 * Found by checking the owner's own setup before letting him test BEA-1457: his email agent's worker
 * was v1, built the day before the tools were opened, and **every existing signal stayed silent**.
 * The plan had not changed, so `stale` was false. The kit MAJOR had not moved, because opening the
 * tools was purely additive and moving it would have made the runner refuse every worker on the box.
 * So the screen said "worker v1, current" about a program with no `kit.call`, no `kit.facts`, no
 * `kit.think` and no `kit.research` — and the only way to find out was to remember this conversation.
 *
 * That is the same shape as the bug the whole week has been about: a capability added on one side,
 * and something on the other side that never heard about it. So it gets its own signal, its own
 * words, and a test that says why it may never be folded into `stale`.
 */

const REV = 'a1b2c3d4e5f6';
const promoted = (over: any = {}) => ({ status: 'promoted', version: 1, planHash: 'sha256:x', kitRev: REV, ...over });

describe('is this worker missing tools it was never told about?', () => {
  it('says nothing when the parts box is the one it was built against', () => {
    expect(partsBox(promoted(), REV)).toEqual({ partsBoxOld: false });
  });

  it('says so when the parts box has changed underneath it', () => {
    const out = partsBox(promoted(), 'ffffffffffff');
    expect(out.partsBoxOld).toBe(true);
    expect(out.partsBoxNote).toContain('older parts box');
    // The reassurance matters as much as the warning: he must not think his job changed.
    expect(out.partsBoxNote).toContain('the plan is unchanged');
  });

  it('treats a worker with NO stamp as old — because that is the truth about it', () => {
    // Every build made before this column existed. Those really were compiled against a kit with
    // none of the new doors, so "unknown" must read as old, never as "probably fine".
    const out = partsBox(promoted({ kitRev: null }), REV);
    expect(out.partsBoxOld).toBe(true);
    expect(out.partsBoxNote).toContain('built before the tools were opened up');
    expect(out.partsBoxNote).toContain('never sees what a service really answers');
  });

  it('says nothing when there is no worker at all', () => {
    expect(partsBox(null, REV)).toEqual({ partsBoxOld: false });
  });

  it('says nothing when the server cannot read its own kit', () => {
    // A kit that cannot be read is already a loud failure at build time (`kit()` throws). It must
    // not ALSO turn into "your worker is out of date" on a screen — that would be a second, wrong
    // explanation for a problem that has nothing to do with the worker.
    expect(partsBox(promoted({ kitRev: null }), null)).toEqual({ partsBoxOld: false });
  });

  it('is not the same thing as stale, and must never be folded into it', () => {
    // stale = "the plan changed, this program no longer does what the job says" → distrust it.
    // partsBoxOld = "the plan is exactly right, there are tools it was never told about" → it still
    // runs correctly. Merging them would either make a correct worker look broken, or hide a real
    // plan drift behind a softer sentence.
    const sameplan = partsBox(promoted({ kitRev: null }), REV);
    expect(sameplan.partsBoxOld).toBe(true);
    expect(sameplan.partsBoxNote).not.toMatch(/stale|out of date with the plan|no longer does/i);
  });
});
