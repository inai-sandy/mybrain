import { describe, it, expect } from 'vitest';

/**
 * The agents home follows the approved design (BEA-1533).
 *
 * `design/agents-redesign/concept-1-mission-control.html` is the design he approved: **what needs
 * you · what is running · what landed**, in that order, above the agents themselves.
 *
 * It was built, then taken apart. BEA-1181 removed "Running now" and "Landed today" on the reasoning
 * that History covers them, and pushed "Needs you" BELOW the agents grid. With ten agents that put
 * the most urgent thing on the page — a job stopped, waiting for an answer — off the bottom of the
 * screen. His words: *"Check our design files. You have given beautiful designs. None of it is
 * replicating now. You have done twice."*
 *
 * The data never went away: `/api/agent/home` has served `running` and `landed` throughout. Only the
 * drawing was missing. These tests hold the structure so it cannot quietly flatten again.
 */
describe('the agents home matches the approved design', () => {
  const src = () => require('fs').readFileSync(__dirname + '/Agents.tsx', 'utf8');

  it('has all three Mission Control strips', () => {
    const s = src();
    for (const id of ['mc-waiting', 'mc-running', 'mc-landed']) expect(s).toContain(`data-testid="${id}"`);
  });

  // Order is the design. "Waiting on you" first is the whole point — it is the only thing on this
  // page that is blocked on him.
  it('puts them in the designed order, above the agents grid', () => {
    const s = src();
    const w = s.indexOf('data-testid="mc-waiting"');
    const r = s.indexOf('data-testid="mc-running"');
    const l = s.indexOf('data-testid="mc-landed"');
    const grid = s.indexOf('\u{1F5C2} Your agents');   // the section comment, not the hint text
    expect(w).toBeGreaterThan(-1);
    expect(grid).toBeGreaterThan(-1);
    expect(w).toBeLessThan(r);
    expect(r).toBeLessThan(l);
    expect(l).toBeLessThan(grid);
  });

  it('draws a live run with the steps it has taken', () => {
    const s = src();
    expect(s).toContain('function RunningCard');
    expect(s).toMatch(/r\.steps/);
    expect(s).toContain('animate-ping'); // the live dot from the design
  });

  it('draws what landed with a status pill', () => {
    const s = src();
    expect(s).toContain('function LandedRow');
    expect(s).toMatch(/l\.status/);
  });

  // The regression that prompted all of this: the waiting cards were rendered last.
  it('never renders the waiting cards after the agents grid again', () => {
    const s = src();
    const lastWaiting = s.lastIndexOf('<WaitingCard');
    const grid = s.indexOf('\u{1F5C2} Your agents');
    expect(grid).toBeGreaterThan(-1);
    expect(lastWaiting).toBeLessThan(grid);
  });

  // A job that ran four times overnight filled the strip with four identical lines and pushed the
  // rest off the screen. The design shows what DIFFERENT agents did.
  it('shows one landed row per agent, not every run', () => {
    const s = src();
    expect(s).toMatch(/const seen = new Set<string>\(\)/);
    expect(s).toMatch(/if \(seen\.has\(key\)\) continue/);
  });

  it('reads running and landed from the home payload the API already serves', () => {
    const s = src();
    expect(s).toMatch(/const running = home\?\.running/);
    expect(s).toMatch(/home\?\.landed/);   // read inside the per-agent dedupe
  });
});

/**
 * The agent row carries the two facts the approved mockup shows (BEA-1535).
 *
 * The redesign artifact's row reads "✅ ran 3h ago · every day at 22:00 · Notion" with an on/off
 * pill. The live card showed only "1 job · ran 3h ago" — so you could not tell when an agent next
 * runs, or whether it is even switched on, without opening it. Both facts were already in the
 * payload; the card just never drew them.
 */
describe('the agent row says when it runs and whether it is on', () => {
  const src = () => require('fs').readFileSync(__dirname + '/Agents.tsx', 'utf8');

  it('draws the schedule and an on/off pill', () => {
    const s = src();
    expect(s).toContain('function schedOf');
    expect(s).toContain('function anyOn');
    expect(s).toMatch(/\{schedOf\(ar\)\}/);
    expect(s).toMatch(/anyOn\(ar\) \? 'on' : 'off'/);
  });

  // "Manual only. Runs when you press Run." is not a schedule; printing it on every row is noise.
  it('does not print "manual only" as if it were a schedule', () => {
    expect(src()).toMatch(/manual only/i);
  });

  // An agent with no jobs yet should not read as switched off.
  it('treats an agent with no jobs as on', () => {
    expect(src()).toMatch(/jobs\.length === 0 \? true/);
  });
});

/**
 * Cards or list, and Landed today folded away (BEA-1539) — both his asks.
 *
 * "i need list view" — the redesign mockup always had a `▦ ▤` toggle; only the card grid was built.
 * A list is better for scanning names, schedules and what ran when; cards are better for browsing.
 *
 * "LANDED TODAY has to be accordian" — what landed is reassurance, not a decision, so it should not
 * hold permanent height above the agents.
 */
describe('the agents home offers both views', () => {
  const src = () => require('fs').readFileSync(__dirname + '/Agents.tsx', 'utf8');

  it('has a cards/list toggle', () => {
    const s = src();
    expect(s).toContain('data-testid={`view-${v}`}');
    expect(s).toMatch(/'cards' \| 'list'/);
  });

  it('remembers which view he picked', () => {
    const s = src();
    expect(s).toMatch(/localStorage\.getItem\('agents\.view'\)/);
    expect(s).toMatch(/localStorage\.setItem\('agents\.view', v\)/);
  });

  /**
   * The list is a LIST, not a table (BEA-1564, second pass).
   *
   * This used to assert `cardsOnly={view === 'cards'}` — i.e. that list view fell through to a
   * column-headed HTML table. He rejected that: *"this design has to be list view, not table view …
   * check the link https://mybrain.1site.ai/documents?folder=others … it has to follow the same
   * design language."* `/documents` draws its list as a stack of bordered rows through
   * `renderCard` + `space-y-2`, and this page now does the same, so the assertion is inverted.
   */
  it('draws both views as rows, never as a column-headed table', () => {
    const s = src();
    expect(s).toMatch(/\n\s*cardsOnly\n/);                       // always on — no table road left
    expect(s).not.toMatch(/cardsOnly=\{view === 'cards'\}/);
    expect(s).not.toMatch(/tableLayoutFixed/);
  });

  // The same stack `/documents` uses for its list, so the two pages read as one product.
  it('stacks the list rows the way Documents does', () => {
    expect(src()).toMatch(/view === 'list' \? 'space-y-2'/);
  });

  it('gives the list its own row renderer', () => {
    const s = src();
    expect(s).toContain('function AgentListRow(');
    expect(s).toMatch(/renderCard=\{view === 'list'/);
  });

  // The search box must find the same agents in both views. Keying the first column on `search`
  // rather than `name` is what makes that true — DataTable matches against column values.
  it('searches the same text in list view as in cards', () => {
    expect(src()).toMatch(/\{ key: 'search', label: 'Agent'/);
  });

  // Still true, by a different mechanism: the row owns its own click now (a real <button> around
  // the title, like Documents' row), rather than DataTable's whole-row handler.
  it('a list row opens the agent', () => {
    const s = src();
    // Structural, not formatting: this pinned the one-line JSX and broke the moment BEA-1576 added
    // the row menu and prettier wrapped the call across lines.
    expect(s).toMatch(/<AgentListRow[\s\S]{0,200}onOpen=/);
    expect(s).toMatch(/<button onClick=\{onOpen\}/);
  });
});

describe('Landed today folds away', () => {
  const src = () => require('fs').readFileSync(__dirname + '/Agents.tsx', 'utf8');

  it('is an accordion, not a permanent block', () => {
    const s = src();
    expect(s).toMatch(/<details open=\{landed\.some/);
  });

  // A failure is the one case you want in front of you rather than behind a tap.
  it('stays open when something failed', () => {
    expect(src()).toMatch(/open=\{landed\.some\(\(l\) => l\.status !== 'done'\)\}/);
  });

  it('says the count and any failures while closed', () => {
    const s = src();
    expect(s).toMatch(/failed<\/span>/);
  });
});
