import { describe, it, expect } from 'vitest';

/**
 * The run screen says where you are (BEA-1537).
 *
 * `web/public/agent-vision.html` — the live-run screen he designed — puts a `● Running` pill and
 * **"Step 2 of 5"** in the header, so you can see how far in a job is at a glance. The caption states
 * the intent: *"The plan ticks off on the left, what it's doing reads in plain English on the right."*
 *
 * The live screen had neither. It is one flat log — readable, but with fifteen steps you had to read
 * all of them to work out whether the job was nearly done or barely started.
 *
 * The counter is honest rather than invented: we do not know a plan up front for every road, so it
 * counts the steps that have actually happened rather than pretending to know the total in advance.
 */
describe('the run screen shows progress, as the design does', () => {
  const src = () => require('fs').readFileSync(__dirname + '/AgentRunView.tsx', 'utf8');

  it('has a progress line', () => {
    const s = src();
    expect(s).toContain('data-testid="run-progress"');
    expect(s).toMatch(/Step \$\{progress\.at\} of \$\{progress\.total\}/);
  });

  // An `info` step is the agent talking about itself — "Running this job's worker (v10)". Counting
  // those as work would overstate progress on every single run.
  it('does not count an agent talking about itself as a step of work', () => {
    const s = src();
    expect(s).toMatch(/kind !== 'info'/);
    expect(s).toMatch(/kind !== 'log'/);
  });

  it('names the step it is on', () => {
    expect(src()).toMatch(/progress\.now/);
  });

  // While it runs you want "where am I"; once finished that is meaningless and the total is the fact.
  it('reads as a running position, then as a total once it has finished', () => {
    const s = src();
    expect(s).toMatch(/active \? `Step \$\{progress\.at\}/);
    expect(s).toMatch(/step\$\{progress\.total === 1 \? '' : 's'\}/);
  });

  it('shows nothing at all when there are no real steps', () => {
    expect(src()).toMatch(/progress\.total > 0 &&/);
  });
});

/**
 * A finished run does not look like it is still working (BEA-1537).
 *
 * Found by building the progress line: on a run that finished hours earlier, several steps were still
 * marked `running` — a worker that exits without stamping its last update leaves them that way. They
 * were drawn as spinning blue loaders, so a completed job appeared to be working for ever, and the
 * progress line named the FIRST such step as "now" on a job that had long since finished.
 */
describe('a finished run stops spinning', () => {
  const src = () => require('fs').readFileSync(__dirname + '/AgentRunView.tsx', 'utf8');

  it('the step icon knows whether the run is still going', () => {
    const s = src();
    expect(s).toMatch(/function StepIcon\(\{ status, live/);
    expect(s).toMatch(/<StepIcon status=\{s\.status\} live=\{active\}/);
  });

  it('only spins while the run is actually live', () => {
    expect(src()).toMatch(/status === 'running'\) return live/);
  });

  // The bug this replaced: picking a stuck-running step on a finished run named step one as "now".
  it('takes the last step as "now" once the run is over', () => {
    const s = src();
    expect(s).toMatch(/const stillGoing = real\.find/);
    expect(s).toMatch(/&& stillGoing\s*\n?\s*\? stillGoing/);
  });
});
