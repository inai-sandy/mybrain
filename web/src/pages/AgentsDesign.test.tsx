import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { latestRun, isDraftShell, RUN_TONE } from './Agents';

/**
 * The Agents design pass (BEA-1564).
 *
 * His words, 2026-08-29: *"The design, the overall design of Agents, has to be super professional …
 * The font sizes are not professional. It's uneven. The list view should have a lot of information.
 * It's not there. Even after deleting an agent, it is showing in the list of agents, but when I
 * click on it, nothing is there inside."*
 *
 * Two of those are measurable and both are locked here. The third — the decision card — is a look,
 * and a test that pinned its classes would break every time it is improved; what IS locked about it
 * is that it no longer paints itself amber-on-amber.
 */

const AGENTS = path.join(__dirname, 'Agents.tsx');
const MODULE_FILES = ['Agents.tsx', 'AgentApp.tsx', 'AgentJobPanels.tsx', 'AgentWorkerRow.tsx', 'AgentRunView.tsx', 'AgentHistory.tsx'];

describe('the last run is the LAST run, whatever happened in it', () => {
  /**
   * The bug, exactly. The list and the card both reached for the last run whose status was `done`,
   * so his ESP32 agent — which failed at 03:00 — displayed "1d ago" from an older success and read
   * as healthy. A list whose health column cannot show ill health is worse than not having one.
   */
  it('reports a failure rather than the last success before it', () => {
    const area = {
      jobs: [
        { lastRun: { status: 'done', at: '2026-08-27T10:00:00Z' } },
        { lastRun: { status: 'failed', at: '2026-08-29T03:00:00Z' } },
      ],
    };
    expect(latestRun(area)?.status).toBe('failed');
    expect(latestRun(area)?.at).toBe('2026-08-29T03:00:00Z');
  });

  it('still reports a success when the newest run succeeded', () => {
    const area = {
      jobs: [
        { lastRun: { status: 'failed', at: '2026-08-27T10:00:00Z' } },
        { lastRun: { status: 'done', at: '2026-08-29T03:00:00Z' } },
      ],
    };
    expect(latestRun(area)?.status).toBe('done');
  });

  it('says nothing at all for an agent that has never run', () => {
    expect(latestRun({ jobs: [{ lastRun: null }] })).toBeUndefined();
    expect(latestRun({ jobs: [] })).toBeUndefined();
    expect(latestRun({})).toBeUndefined();
  });

  // A run parked on a question is not a failure and must not wear the failure colour — that is the
  // one status he most needs to tell apart at a glance.
  it('gives a waiting run its own words, apart from a failure', () => {
    expect(RUN_TONE.awaiting_input.label).toBe('needs you');
    expect(RUN_TONE.awaiting_input.cls).not.toBe(RUN_TONE.failed.cls);
    expect(RUN_TONE.failed.label).toBe('failed');
  });
});

describe('an empty area is a draft, not an agent', () => {
  /**
   * Four areas named "New agent" with nothing inside them were sitting in his list on 28 Aug.
   * `builder/send-to-codex` makes the area BEFORE the goal is written, so a goal that fails — his
   * AI budget ran out that day — strands the shell, and `deleteAgent` never removes the area it
   * emptied either.
   */
  it('treats an area with no jobs as a draft', () => {
    expect(isDraftShell({ jobCount: 0, jobs: [] })).toBe(true);
    expect(isDraftShell({})).toBe(true);
  });

  it('never treats an area that holds a job as a draft', () => {
    expect(isDraftShell({ jobCount: 1, jobs: [{ id: 'j1' }] })).toBe(false);
    // Belt and braces: either field alone proving there is something inside is enough.
    expect(isDraftShell({ jobCount: 1, jobs: [] })).toBe(false);
    expect(isDraftShell({ jobCount: 0, jobs: [{ id: 'j1' }] })).toBe(false);
  });

  /**
   * The split has to happen where the data ARRIVES, not in the table. The header count, the folder
   * counts and the tab counts are all derived from `areasList`, and a count that disagrees with the
   * list it counts is the bug this module keeps reproducing.
   */
  it('filters the drafts out of the loaded list, not just out of the table', () => {
    const s = fs.readFileSync(AGENTS, 'utf8');
    const load = s.slice(s.indexOf('const loadAreas'), s.indexOf('useEffect(() => { loadAreas();'));
    expect(load).toMatch(/setAreasList\(.*isDraftShell/s);
    expect(load).toContain('setDrafts(');
  });

  // Nothing is deleted behind his back — his standing rule. The drafts are counted and he taps.
  it('offers the cleanup rather than doing it unasked', () => {
    const s = fs.readFileSync(AGENTS, 'utf8');
    expect(s).toContain('data-testid="clear-drafts"');
    // It walks the ids it counted, never a server-side "delete everything empty".
    expect(s).toMatch(/drafts\.map\(\(d: any\) => d\.id\)/);
  });
});

describe('one type scale across the module', () => {
  /**
   * Measured on the live page before this: FOURTEEN distinct size/weight pairs on one screen, and
   * 43 elements rendering at 10px — below a readable UI minimum. His words: *"The font sizes are not
   * professional. It's uneven."*
   *
   * The scale is Tailwind's own: `text-xl` title, `text-sm` titles and body, `text-xs` meta. A
   * one-off pixel size is how the drift started, so the guard is against those.
   */
  it('has no hand-picked pixel font sizes left anywhere in the module', () => {
    const offenders: string[] = [];
    for (const f of MODULE_FILES) {
      const p = path.join(__dirname, f);
      if (!fs.existsSync(p)) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/text-\[[0-9.]+px\]/g)) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the decision card is calm', () => {
  /**
   * His words: *"The decision card which is Waiting for my answer, that particular window is popping
   * out, and it's too ugly."* It was an amber card holding an amber pill, a coloured icon, a white
   * inner box and a second inner box — the loudest thing on a page that is otherwise quiet zinc.
   *
   * The look itself is not pinned here (that would break every improvement), but the two things
   * that made it shout are: it no longer fills itself amber, and it no longer nests a second
   * surface inside itself to hold the question.
   */
  const card = () => {
    const s = fs.readFileSync(AGENTS, 'utf8');
    const start = s.indexOf('function WaitingCard(');
    expect(start).toBeGreaterThan(-1);
    // To the next top-level declaration after it.
    const end = s.indexOf('\nfunction ', start + 10);
    return s.slice(start, end > start ? end : undefined);
  };

  it('sits on the ordinary card surface, not an amber wash', () => {
    const c = card();
    expect(c).not.toMatch(/bg-amber-50\/60/);
    expect(c).toMatch(/bg-white/);
  });

  it('keeps a single amber accent so it is still the one thing asking for you', () => {
    expect(card()).toMatch(/border-l-amber-400/);
  });

  it('does not nest another surface inside itself to hold the question', () => {
    // The old card put the question in its own `bg-white/70` box inside the amber one.
    expect(card()).not.toMatch(/bg-white\/70|bg-white\/50/);
  });

  it('puts every control on one height', () => {
    const c = card();
    // Only the things you can actually operate — a <button> or the answer <input>. A paragraph that
    // happens to be rounded is not a control, and an earlier version of this test failed on the
    // validator's warning note for exactly that reason.
    const controls = [...c.matchAll(/<(?:button|input)\b[\s\S]*?className="([^"]*)"/g)].map((m) => m[1]);
    expect(controls.length).toBeGreaterThan(3);
    for (const cls of controls) {
      // The bare text link ("something else…") is not a filled control and carries its own height.
      if (!/\bpx-\d/.test(cls)) continue;
      expect(cls).toMatch(/\bh-9\b/);
    }
  });
});
