import { describe, it, expect } from 'vitest';
import { costLines, ceilingLine, kindOfMade, MADE_KINDS, type AgentCost } from './AgentApp';

/**
 * What an agent costs over time, and how close today is to the ceiling (BEA-1526).
 *
 * One run's cost has been on the run screen since BEA-1394. An agent's cost over time was nowhere, so
 * "is this weekly digest worth what it spends?" had no answer short of adding runs up by hand — and
 * neither was the daily ceiling that can pause a job on its own, which is the number that explains a
 * job switching itself off.
 */
const c = (over: Partial<AgentCost> = {}): AgentCost => ({
  runs: 10, runs30d: 4, credits: 120, credits30d: 40, aiTokens: 52000, aiTokens30d: 18000, calls: 96, firstRunAt: null, ...over,
});

describe('costLines', () => {
  it('says the whole life and the last 30 days', () => {
    const l = costLines(c())!;
    expect(l.all).toBe('120 credits · 52k AI tokens over 10 runs');
    expect(l.recent).toBe('Last 30 days: 40 credits · 18k AI tokens over 4 runs');
  });

  it('works out what a run costs lately', () => {
    expect(costLines(c())!.per).toBe('About 10 credits a run lately');
  });

  it('is nothing at all when it has never run', () => {
    expect(costLines(c({ runs: 0 }))).toBeNull();
    expect(costLines(null)).toBeNull();
  });

  // A run that used only saved answers genuinely costs nothing. "0 credits" reads like a broken
  // counter; saying so plainly does not.
  it('says "nothing yet" rather than zero when it has run but never spent', () => {
    const l = costLines(c({ credits: 0, credits30d: 0, aiTokens: 0, aiTokens30d: 0 }))!;
    expect(l.all).toBe('nothing yet, over 10 runs');
    expect(l.per).toBe('No credits spent lately');
  });

  it('handles an agent that ran long ago but not lately', () => {
    const l = costLines(c({ runs30d: 0, credits30d: 0, aiTokens30d: 0 }))!;
    expect(l.recent).toBe('Last 30 days: it has not run');
  });

  it('gets the singulars right', () => {
    const l = costLines(c({ runs: 1, runs30d: 1, credits: 1, credits30d: 1 }))!;
    expect(l.all).toContain('1 credit ·');
    expect(l.all).toContain('over 1 run');
  });
});

describe('ceilingLine', () => {
  it('says how much of today is used and the share', () => {
    expect(ceilingLine({ spentToday: 100, ceiling: 500 })).toBe('100 of 500 credits used today across all agents (20%)');
  });

  // The warning is the point: past the ceiling a job switches ITSELF off, which is exactly the
  // situation that looked like a broken agent in BEA-1524.
  it('warns when it is close, because past it a job pauses itself', () => {
    expect(ceilingLine({ spentToday: 450, ceiling: 500 })).toContain('close to the limit');
    expect(ceilingLine({ spentToday: 100, ceiling: 500 })).not.toContain('close to the limit');
  });

  it('says plainly when no limit is set', () => {
    expect(ceilingLine({ spentToday: 12, ceiling: 0 })).toContain('no daily limit set');
  });

  it('shows nothing at all when the figure is unknown', () => {
    expect(ceilingLine(null)).toBeNull();
    expect(ceilingLine({})).toBeNull();
  });
});

describe('kindOfMade', () => {
  const item = (icon: string) => ({ id: '1', title: 't', href: 'h', icon, at: '' });

  it('names each kind', () => {
    expect(kindOfMade(item('\u{1F4CA}'))).toBe('Google Sheet');
    expect(kindOfMade(item('\u{1F5D2}️'))).toBe('Notion page');
    expect(kindOfMade(item('\u{1F4C4}'))).toBe('Document');
  });

  // The filter's options and the function must agree, or a kind exists that cannot be filtered for.
  it('every kind it can return is offered as a filter option', () => {
    for (const icon of ['\u{1F4CA}', '\u{1F5D2}️', '\u{1F4C4}']) {
      expect(MADE_KINDS).toContain(kindOfMade(item(icon)));
    }
  });
});

/**
 * Run result lines wrap on a phone (BEA-1529).
 *
 * These lines carry whatever a run reported — a Google Sheet URL, a markdown table row. A long
 * unbroken URL will not wrap, and inside a flex row it pushed the line to 684px in a 324px column at
 * 390: clipped, with no way to read the rest. The page never scrolled sideways, so no width assertion
 * caught it — the same shape as the card bug in BEA-1525.
 */
describe('run result lines survive a phone', () => {
  const src = () => require('fs').readFileSync(__dirname + '/AgentApp.tsx', 'utf8');

  it('the result line can wrap and can shrink', () => {
    const line = src().match(/<li key=\{i\} className="flex items-start gap-2 text-sm">.*?<\/li>/s);
    expect(line).toBeTruthy();
    expect(line![0]).toContain('min-w-0');
    expect(line![0]).toContain('break-words');
  });

  it('the tick beside it never shrinks instead of the text', () => {
    const line = src().match(/<li key=\{i\} className="flex items-start gap-2 text-sm">.*?<\/li>/s);
    expect(line![0]).toContain('shrink-0');
  });
});

describe('the made list is on the shared table', () => {
  const src = () => require('fs').readFileSync(__dirname + '/AgentApp.tsx', 'utf8');

  it('renders through DataTable, with search, a kind filter and sorting', () => {
    const s = src();
    expect(s).toContain("import { DataTable }");
    expect(s).toMatch(/DataTable<MadeRow>/);
    expect(s).toContain('searchable');
    expect(s).toMatch(/filters=\{\[\{ key: 'kind'/);
  });

  // The old hand-rolled cap is what the shared table replaced; leaving it would mean two paginations.
  it('no longer caps the list by hand', () => {
    expect(src()).not.toContain('madeAll');
  });

  // The export used to re-derive the kind from the icon inline, so a new kind would show correctly on
  // screen and export as "Document".
  it('the CSV export reads the same kind function the list does', () => {
    const s = src();
    expect(s).toContain('kindOfMade(m), m.href');           // the export's own columns
    expect(s).not.toContain("m.icon === '\\u{1F4CA}' ?");   // the old inline re-derivation is gone
  });
});
