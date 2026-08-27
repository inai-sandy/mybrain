import { describe, expect, it } from 'vitest';
import { madeFromRuns } from './AgentApp';

/**
 * WHAT AN AGENT HAS MADE (BEA-1507).
 *
 * His results scattered — a Google Sheet from the ESP32 agent, a Notion page from the email one, a
 * My Brain document from the GitHub one — and no screen showed a single agent's output over time.
 * Derived from the runs, so it can never drift from the history it came from.
 */
describe('the things an agent has produced', () => {
  const run = (over: any) => ({ id: 'r', title: 'T', status: 'done', endedAt: '2026-08-27T03:00:00Z', ...over });

  it('picks the right icon for each kind of result', () => {
    const made = madeFromRuns([
      run({ id: '1', outputUrl: 'https://docs.google.com/spreadsheets/d/abc', resultText: 'Created ESP32-2026-08-27' }),
      run({ id: '2', outputUrl: 'https://app.notion.com/p/Email-Summary', resultText: 'Created the daily report' }),
      run({ id: '3', outputDocId: 'doc-9', resultText: 'Saved GitHub top 5' }),
    ]);
    expect(made.map((m) => m.icon)).toEqual(['📊', '🗒️', '📄']);
    // A document with no url still gets somewhere to go.
    expect(made[2].href).toBe('/documents/doc-9');
  });

  it('leaves out a run that wrote nothing', () => {
    // A run that finished honestly with no output is not a thing it made.
    const made = madeFromRuns([run({ id: '1', resultText: 'Nothing important today' }), run({ id: '2', outputDocId: 'd' })]);
    expect(made.map((m) => m.id)).toEqual(['2']);
  });

  it('puts the newest first', () => {
    const made = madeFromRuns([
      run({ id: 'old', outputDocId: 'a', endedAt: '2026-08-20T03:00:00Z' }),
      run({ id: 'new', outputDocId: 'b', endedAt: '2026-08-27T03:00:00Z' }),
    ]);
    expect(made.map((m) => m.id)).toEqual(['new', 'old']);
  });

  it('is quiet when there are no runs at all', () => {
    expect(madeFromRuns(null)).toEqual([]);
    expect(madeFromRuns([])).toEqual([]);
  });
});
