import { FlowRunnerService } from './flows-runner.service';

/**
 * BEA-1192 — a branch does dozens of searches over several minutes and NONE of it reached the flow.
 * The flow logged "started" and then nothing until everything finished, so a healthy five-minute run
 * was indistinguishable from a broken one — which is exactly how one came to be reported as stuck.
 */
function svc(stepLogs: any[][]) {
  let call = 0;
  const prisma: any = {
    agentRun: { findUnique: async () => ({ stepLog: JSON.stringify(stepLogs[Math.min(call++, stepLogs.length - 1)]) }) },
  };
  return new FlowRunnerService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
}

describe('a running flow shows what it is doing (BEA-1192)', () => {
  it('mirrors the branch\'s real steps into the flow, and never repeats one', async () => {
    const lines: string[] = [];
    const s: any = svc([
      [{ label: '🌐 Searched: placements 2026' }, { label: '🌐 Searched: COEP stats' }],
      [{ label: '🌐 Searched: placements 2026' }, { label: '🌐 Searched: COEP stats' }, { label: '💬 wrote the answer' }],
    ]);
    const stop = s.mirrorSteps('run-1', (t: string) => lines.push(t));
    await new Promise((r) => setTimeout(r, 4300));
    await new Promise((r) => setTimeout(r, 4300));
    stop();
    expect(lines.some((l) => l.includes('placements 2026'))).toBe(true);
    expect(lines.some((l) => l.includes('wrote the answer'))).toBe(true);
    // each step appears once, however many times it is polled
    expect(lines.filter((l) => l.includes('COEP stats')).length).toBe(1);
  }, 15000);

  it('does nothing at all when there is nowhere to write', () => {
    const s: any = svc([[]]);
    const stop = s.mirrorSteps('run-1', undefined);
    expect(typeof stop).toBe('function');
    stop(); // must not throw
  });

  it('says a branch is waiting when the engine is already busy', async () => {
    const lines: string[] = [];
    const s: any = svc([[]]);
    s.engineQueued = 1; // another branch holds the engine
    s.agent = { createRun: async () => ({ id: 'r1' }), getRun: async () => ({ status: 'done', resultText: 'x' }) };
    s.bridge = { execute: async () => undefined };
    await s.agentRun('p', 'Branch 2', null, (t: string) => lines.push(t));
    expect(lines[0]).toContain('waiting its turn');
    expect(lines.some((l) => l.includes('working'))).toBe(true);
  }, 15000);
});

/**
 * BEA-1194 — the two behaviours that made a 14-minute run produce an empty report.
 */
describe('search is a real call, and thinking fails loudly (BEA-1194)', () => {
  const runner = (web?: any, llm?: any) =>
    new FlowRunnerService({} as any, {} as any, {} as any, llm || {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, web);

  it('a web search calls Tavily — it does NOT spawn an engine turn', async () => {
    let engineUsed = false;
    const web = { search: async () => [{ title: 'T', url: 'https://a', snippet: 's' }], asMarkdown: () => 'Sources found…' };
    const s: any = runner(web);
    s.agentRun = async () => { engineUsed = true; return 'from the engine'; };
    const out = await s.runNode({ data: { kind: 'tool', refId: 'web_search', label: 'Web search' } }, 'placements 2026', []);
    expect(out).toContain('Sources found');
    expect(engineUsed).toBe(false);
  });

  it('a meaning search goes to Exa, not Tavily', async () => {
    let which = '';
    const web = { search: async () => { which = 'tavily'; return []; }, searchByMeaning: async () => { which = 'exa'; return []; }, asMarkdown: () => 'x' };
    const s: any = runner(web);
    await s.runNode({ data: { kind: 'tool', refId: 'web_search_meaning', label: 'Search by meaning' } }, 'what is changing', []);
    expect(which).toBe('exa');
  });

  it('a search failure throws with its reason, so the step is marked failed', async () => {
    const web = { search: async () => { throw new Error('Tavily is out of credits or rate-limited right now.'); } };
    const s: any = runner(web);
    await expect(s.runNode({ data: { kind: 'tool', refId: 'web_search', label: 'Web search' } }, 'q', [])).rejects.toThrow(/out of credits/);
  });

  it('a thinking step that cannot think throws instead of returning nothing', async () => {
    const llm = { completeDetailed: async () => ({ text: null, error: 'qwen/qwen3.7-max returned nothing — it may be rate-limited' }) };
    const s: any = runner(undefined, llm);
    await expect(s.runNode({ data: { kind: 'ask_ai', label: 'Ask AI' } }, 'lots of research material', [])).rejects.toThrow(/rate-limited/);
  });

  it('a thinking step that works still returns its answer', async () => {
    const llm = { completeDetailed: async () => ({ text: 'the written section', error: null }) };
    const s: any = runner(undefined, llm);
    expect(await (runner(undefined, llm) as any).runNode({ data: { kind: 'ask_ai' } }, 'material', [])).toBe('the written section');
  });
});

/**
 * BEA-1196 — deep research is OUR loop on the flat-rate engine, not a paid product and not an engine
 * turn that decides for itself how to research. These pin the wiring: the flow calls the service, the
 * toolbox still gates it, and what it spent comes back so the run can record it.
 */
describe('deep research is our own loop (BEA-1196)', () => {
  const runner = (deep?: any) =>
    new FlowRunnerService({} as any, {} as any, {} as any, {} as any as any, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, deep);

  const node = { data: { kind: 'tool', refId: 'deep_research', label: 'Deep research' } };

  it('calls the research service and never the engine', async () => {
    let engineUsed = false;
    const deep = { run: async () => ({ report: 'The report\n\n### Sources\n\n1. [A](https://a)', spend: { searches: 4, extracts: 3, sources: 9 } }) };
    const s: any = runner(deep);
    s.agentRun = async () => { engineUsed = true; return 'from the engine'; };
    const out = await s.runNode(node, 'what is changing in fresher hiring', []);
    expect(out).toContain('### Sources');
    expect(engineUsed).toBe(false);
  });

  it('hands back what it spent, so the run can record the real cost', async () => {
    const spent: any[] = [];
    const deep = { run: async () => ({ report: 'r', spend: { searches: 6, extracts: 4, sources: 12 } }) };
    const s: any = runner(deep);
    await s.runNode(node, 'q', [], null, null, undefined, (x: any) => spent.push(x));
    expect(spent).toEqual([{ searches: 6, extracts: 4, sources: 12 }]);
  });

  it('passes the node\'s own limits through as the budget', async () => {
    let got: any = null;
    const deep = { run: async (_q: string, o: any) => { got = o.budget; return { report: 'r', spend: { searches: 1, extracts: 0, sources: 1 } }; } };
    const s: any = runner(deep);
    await s.runNode({ data: { ...node.data, maxSearches: 3, maxReads: 2 } }, 'q', []);
    expect(got).toEqual({ searches: 3, extracts: 2 });
  });

  it('records the spend of a FAILED attempt too, so a retry cannot hide the cost', async () => {
    const spent: any[] = [];
    const boom: any = new Error('the searches found nothing to work from');
    boom.spend = { searches: 5, extracts: 0, sources: 0 };
    const deep = { run: async () => { throw boom; } };
    const s: any = runner(deep);
    await expect(s.runNode(node, 'q', [], null, null, undefined, (x: any) => spent.push(x))).rejects.toThrow(/found nothing/);
    expect(spent).toEqual([{ searches: 5, extracts: 0, sources: 0 }]);
  });

  it('is still gated by the agent toolbox', async () => {
    const deep = { run: async () => { throw new Error('should never be called'); } };
    const s: any = runner(deep);
    const out = await s.runNode(node, 'q', [], new Set(['web_search']));
    expect(out).toMatch(/not in this agent's toolbox/);
  });

  it('says so plainly when research is not available on this server', async () => {
    const s: any = runner(undefined);
    await expect(s.runNode(node, 'q', [])).rejects.toThrow(/not available on this server/);
  });

  it('lets a failure through, so the step is marked failed with the reason', async () => {
    const deep = { run: async () => { throw new Error('the searches found nothing to work from'); } };
    const s: any = runner(deep);
    await expect(s.runNode(node, 'q', [])).rejects.toThrow(/found nothing to work from/);
  });
});

/**
 * BEA-1199 — a flow ending in an HTML skill produced a whole page as its answer, and every one was
 * filed as `kind: 'md'`. The owner opened his 36KB report and got raw source. The description was
 * built the same way, so it read "<!doctype html> <html lang=…".
 */
describe('an HTML answer is saved as HTML (BEA-1199)', () => {
  const runner = () => new FlowRunnerService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  const page = '<!doctype html>\n<html lang="en">\n<head><style>.a{color:red}</style><script>var x=1</script></head>\n<body><h1>City Placement Review</h1><p>The sources do not cover 2026.</p></body>\n</html>';

  it('files a page as kind html, described by its words not its markup', async () => {
    let saved: any = null;
    const s: any = runner();
    (s as any).documents = { create: async (d: any) => { saved = d; return { id: 'd1', slug: 's1', title: d.title }; } };
    await s.saveDoc('Report — result', page, 'Report');
    expect(saved.kind).toBe('html');
    expect(saved.description).toContain('City Placement Review');
    expect(saved.description).not.toContain('<!doctype');
    expect(saved.description).not.toContain('color:red');   // style and script are stripped
    expect(saved.description).not.toContain('var x');
    expect(saved.contentText).toBe(page);                    // the page itself is stored untouched
  });

  it('still files ordinary research as markdown', async () => {
    let saved: any = null;
    const s: any = runner();
    (s as any).documents = { create: async (d: any) => { saved = d; return { id: 'd2', slug: 's2', title: d.title }; } };
    await s.saveDoc('Report — research', '# Findings\n\nThe sources say...', 'Report');
    expect(saved.kind).toBe('md');
    expect(saved.description).toContain('Findings');
  });

  it('is not fooled by markdown that merely mentions html', async () => {
    let saved: any = null;
    const s: any = runner();
    (s as any).documents = { create: async (d: any) => { saved = d; return { id: 'd3', slug: 's3', title: d.title }; } };
    await s.saveDoc('x', 'Here is some `<html>` in a sentence about HTML pages.', 'Report');
    expect(saved.kind).toBe('md');
  });
});

/** Review finding on BEA-1199: a model asked for "an HTML page" usually replies inside a fence. */
describe('fenced HTML is still HTML (BEA-1199)', () => {
  const runner = () => new FlowRunnerService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const save = async (content: string) => {
    let saved: any = null;
    const s: any = runner();
    (s as any).documents = { create: async (d: any) => { saved = d; return { id: 'd', slug: 's', title: d.title }; } };
    await s.saveDoc('t', content, 'Report');
    return saved;
  };

  it('files a fenced page as html, with the fence removed', async () => {
    const saved = await save('```html\n<!doctype html>\n<html><body><h1>Report</h1></body></html>\n```');
    expect(saved.kind).toBe('html');
    expect(saved.contentText.startsWith('<!doctype html')).toBe(true);
    expect(saved.contentText).not.toContain('```');
  });

  it('leaves an ordinary fenced code block in a markdown document alone', async () => {
    const md = '# Findings\n\n```js\nconst x = 1\n```\n';
    const saved = await save(md);
    expect(saved.kind).toBe('md');
    expect(saved.contentText).toBe(md);   // untouched
  });
});

/**
 * BEA-1200 — a run that failed at its LAST step threw away everything the earlier steps produced.
 * A real run lost 21,651 characters gathered from 95 paid-for searches and said nothing about it.
 * BEA-1193 made research survive a failing final step, but only ever on the success path.
 */
describe('a failed run keeps the research that worked (BEA-1200)', () => {
  const graph = {
    nodes: [
      { id: 'q', data: { kind: 'question', label: 'Question' } },
      { id: 'b0', data: { kind: 'subquestion', label: 'Branch 1', sub: 'graduation numbers' } },
      { id: 'd0', data: { kind: 'tool', refId: 'deep_research', label: 'Deep research' } },
      { id: 'm', data: { kind: 'merge', label: 'Merge' } },
      { id: 'sk', data: { kind: 'skill', refId: 'sk1', label: 'interactive-html' } },
    ],
    edges: [],
  };
  const runner = () => new FlowRunnerService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  it('still writes the research, and the merged text is not lost with it', async () => {
    const saved: any[] = [];
    const s: any = runner();
    (s as any).documents = { create: async (d: any) => { saved.push(d); return { id: 'd' + saved.length, slug: 's', title: d.title }; } };
    const results: any = {
      q: { status: 'done', output: 'the question', kind: 'question' },
      b0: { status: 'done', output: 'graduation numbers', kind: 'subquestion' },
      d0: { status: 'done', output: 'BRANCH FINDINGS with sources', kind: 'tool', label: 'Deep research' },
      m: { status: 'done', output: 'THE COMBINED RESEARCH, 21k characters worth', kind: 'merge' },
      sk: { status: 'failed', output: 'the model returned nothing', kind: 'skill' },
    };
    const docs = await s.saveDocuments({ name: 'Report' }, graph, new Map([['m', ['d0']]]), results, '');
    expect(docs.length).toBeGreaterThan(0);
    const research = saved.find((d) => d.title.includes('research'));
    expect(research).toBeTruthy();
    expect(research.contentText).toContain('BRANCH FINDINGS with sources');
    expect(research.contentText).toContain('THE COMBINED RESEARCH');          // the merge is kept
    expect(research.contentText).toContain('this document is the research');  // and it says why
    expect(saved.some((d) => d.title.includes('— result'))).toBe(false);      // there IS no result
  });

  // Surfaced by this very test: researchMarkdown used a node's `output` whatever its status, and a
  // failed node's output is its error message. "the model returned nothing" under a research
  // heading reads like a finding.
  it('never files an error message as if it were research', async () => {
    const saved: any[] = [];
    const s: any = runner();
    (s as any).documents = { create: async (d: any) => { saved.push(d); return { id: 'z', slug: 's', title: d.title }; } };
    const results: any = {
      d0: { status: 'done', output: 'real findings', kind: 'tool', label: 'Deep research' },
      sk: { status: 'failed', output: 'the model returned nothing', kind: 'skill', label: 'interactive-html' },
    };
    await s.saveDocuments({ name: 'Report' }, graph, new Map(), results, '');
    const research = saved.find((d) => d.title.includes('research'));
    expect(research.contentText).toContain('real findings');
    expect(research.contentText).not.toContain('the model returned nothing');
  });

  it('claims nothing when nothing succeeded', async () => {
    const saved: any[] = [];
    const s: any = runner();
    (s as any).documents = { create: async (d: any) => { saved.push(d); return { id: 'x', slug: 's', title: d.title }; } };
    const results: any = { d0: { status: 'failed', output: 'search failed', kind: 'tool' } };
    const docs = await s.saveDocuments({ name: 'Report' }, graph, new Map(), results, '');
    expect(docs).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('keeps the merged text out of the research doc when there IS a result', async () => {
    const saved: any[] = [];
    const s: any = runner();
    (s as any).documents = { create: async (d: any) => { saved.push(d); return { id: 'y', slug: 's', title: d.title }; } };
    const results: any = {
      d0: { status: 'done', output: 'branch findings', kind: 'tool', label: 'Deep research' },
      m: { status: 'done', output: 'THE COMBINED RESEARCH', kind: 'merge' },
    };
    await s.saveDocuments({ name: 'Report' }, graph, new Map(), results, 'THE FINISHED REPORT');
    const research = saved.find((d) => d.title.includes('research'));
    expect(research.contentText).toContain('THE FINISHED REPORT');
    expect(research.contentText).not.toContain('### The combined research'); // not duplicated
  });
});

/**
 * BEA-1203 — eight tools were spawning a 118,000-token engine turn to do work we can simply do.
 * An engine turn costs as much as EIGHT branches of real research, and for `save_document` and
 * `remember` its entire job was to call our own API back.
 *
 * The rule these pin: agency earns an engine turn, transformation does not.
 */
describe('work we can just do never reaches the engine (BEA-1203)', () => {
  // positional: prisma, bridge, agent, llm, documents, memory, skills, telegram, flows,
  //             push, alerts, web, deep, items, tasks, postbox
  const runner = (over: any = {}) => {
    const s: any = new FlowRunnerService(
      over.prisma ?? { setting: { findUnique: async () => ({ value: '+919876543210' }) } } as any,
      {} as any, {} as any, {} as any,
      over.documents ?? {} as any,
      over.memory ?? {} as any,
      {} as any,
      over.telegram ?? {} as any,
      {} as any, undefined, undefined, undefined, undefined,
      over.items, over.tasks, over.postbox,
    );
    s.agentRun = async () => { throw new Error('an engine turn must never be spawned for this'); };
    return s;
  };
  const node = (refId: string, data: any = {}) => ({ data: { kind: 'tool', refId, label: refId, ...data } });

  it('saves a document itself, and titles it from the text', async () => {
    let saved: any = null;
    const s = runner({ documents: { create: async (d: any) => { saved = d; return { id: 'd1', slug: 's', title: d.title }; } } });
    const out = await s.runNode(node('save_document'), '# Fresher hiring in 2026\n\nThe sources say...', []);
    expect(saved.title).toBe('Fresher hiring in 2026');   // the heading, not the generic node label
    expect(saved.contentText).toContain('The sources say');
    expect(out).toContain('Saved to your documents');
  });

  it('creates one task per line, not one giant to-do', async () => {
    const made: string[] = [];
    const s = runner({ tasks: { create: async (d: any) => { made.push(d.title); return d; } } });
    const out = await s.runNode(node('create_task'), '- Call the supplier\n- Send the quote\n\n', []);
    expect(made).toEqual(['Call the supplier', 'Send the quote']);
    expect(out).toContain('Added 2 tasks');
  });

  it('never asks a task to write itself a note — that is a paid call per task', async () => {
    const seen: any[] = [];
    const s = runner({ tasks: { create: async (d: any) => { seen.push(d); return d; } } });
    await s.runNode(node('create_task'), 'One thing to do', []);
    expect(seen[0].auto).toBeUndefined();
  });

  it('remembers straight into the memory outbox', async () => {
    let got: any = null;
    const s = runner({ memory: { enqueue: async (t: string, o: any) => { got = { t, o }; } } });
    await s.runNode(node('remember'), 'Rakesh handles the Friday report', []);
    expect(got.t).toBe('Rakesh handles the Friday report');
    expect(got.o.tags).toContain('flow');
  });

  it('sends Telegram as plain text, because model output breaks HTML mode', async () => {
    const sent: any[] = [];
    const s = runner({ telegram: { ownerChatId: async () => '123', send: async (c: any, t: string, x: any) => { sent.push({ c, t, x }); } } });
    await s.runNode(node('telegram'), 'Costs < 5% and margin > 3 & rising', []);
    expect(sent[0].c).toBe('123');
    expect(sent[0].x.parse_mode).toBeUndefined();   // HTML mode would reject this message outright
  });

  it('splits a long Telegram message instead of losing it', async () => {
    const sent: any[] = [];
    const s = runner({ telegram: { ownerChatId: async () => '1', send: async (_c: any, t: string) => { sent.push(t); } } });
    await s.runNode(node('telegram'), 'x'.repeat(9000), []);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((t) => t.length <= 3900)).toBe(true);
  });

  // Review finding: `api()` resolves with ok:false when Telegram refuses; swallowing that and still
  // saying "sent" is exactly the lie this whole line of work keeps removing.
  it('does not claim success when Telegram refuses the message', async () => {
    const s = runner({ telegram: { ownerChatId: async () => '1', send: async () => ({ ok: false, description: 'bot was blocked by the user' }) } });
    const out = await s.runNode(node('telegram'), 'hello', []);
    expect(out).toMatch(/refused/);
    expect(out).toMatch(/blocked by the user/);
    expect(out).not.toMatch(/Sent to you/);
  });

  it('says how much was actually sent when the text had to be cut', async () => {
    const s = runner({ telegram: { ownerChatId: async () => '1', send: async () => ({ ok: true }) } });
    const out = await s.runNode(node('telegram'), 'x'.repeat(30000), []);
    expect(out).toMatch(/Only the first 19500 characters fitted/);
  });

  it('says so plainly when Telegram is not linked, rather than pretending', async () => {
    const s = runner({ telegram: { ownerChatId: async () => null, send: async () => undefined } });
    const out = await s.runNode(node('telegram'), 'anything', []);
    expect(out).toMatch(/not linked/);
  });

  it('searches only the raw notes for search_rag', async () => {
    let usedBrain = false;
    const s = runner({ memory: {
      searchBrain: async () => { usedBrain = true; return []; },
      searchRag: async () => [{ title: 'A note', content: 'the note body' }],
    } });
    const out = await s.runNode(node('search_rag'), 'production targets', []);
    expect(usedBrain).toBe(false);
    expect(out).toContain('the note body');
  });

  it('finds the document when handed prose instead of an id', async () => {
    const s = runner({ documents: {
      search: async () => ({ documents: [{ id: 'doc-9', title: 'The one' }] }),
      get: async (id: string) => (id === 'doc-9' ? { title: 'The one', contentText: 'full text here' } : null),
    } });
    const out = await s.runNode(node('fetch_document'), 'the placement report', []);
    expect(out).toContain('full text here');
  });

  it('files a capture, and says when it was already there', async () => {
    const s = runner({ items: { store: async () => ({ deduped: true }) } });
    const out = await s.runNode(node('save_capture'), 'a thought worth keeping', []);
    expect(out).toMatch(/already in your captures/);
  });

  it('says when WhatsApp only took part of the message', async () => {
    const s = runner({ postbox: { sendText: async () => ({ status: 'sent' }) } });
    const out = await s.runNode(node('whatsapp'), 'y'.repeat(9000), []);
    expect(out).toMatch(/Only the first 3900 characters fitted/);
  });

  it('reports honestly when WhatsApp refuses the message', async () => {
    const s = runner({ postbox: { sendText: async () => ({ status: 'failed', error: 'outside the window' }) } });
    const out = await s.runNode(node('whatsapp'), 'the update', []);
    expect(out).toMatch(/outside the window/);
  });

  it('still sends anything genuinely agentic to the engine', async () => {
    const s: any = runner();
    s.agentRun = async () => 'from the engine';
    expect(await s.runNode(node('gmail'), 'what did Rakesh send?', [])).toBe('from the engine');
  });

  it('leaves no tool id stranded between the two paths', () => {
    // An id that is neither in AGENT_TOOLS nor handled directly falls through to a plain model call,
    // and the model invents the answer. That is the failure this whole line of work exists to stop.
    const src = require('fs').readFileSync(require('path').join(__dirname, 'flows-runner.service.ts'), 'utf8');
    const engine: string[] = (/AGENT_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] || '').match(/'([a-z_]+)'/g)?.map((x: string) => x.replace(/'/g, '')) || [];
    for (const id of ['save_document', 'save_capture', 'create_task', 'remember', 'telegram', 'whatsapp', 'search_rag', 'fetch_document']) {
      expect(engine).not.toContain(id);                    // no longer an engine turn
      expect(src).toContain(`case '${id}':`);              // and genuinely handled instead
    }
    for (const id of ['gmail', 'drive', 'http', 'cli']) expect(engine).toContain(id); // real access stays
  });
});

/**
 * BEA-1204 — the budget as the flow sees it. The owner's rules: it blocks rather than warns, the
 * step in flight finishes, and work already gathered is never thrown away for it.
 */
describe('the token ceiling inside a run (BEA-1204)', () => {
  const runner = (budget?: any) => new FlowRunnerService(
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    { ownerChatId: async () => null, send: async () => undefined } as any,
    {} as any, undefined, undefined, undefined, undefined, undefined, undefined, undefined, budget,
  );
  const budget = (over: any = {}) => ({
    runLimit: async () => over.runLimit ?? 150_000,
    check: async () => over.day ?? { ok: true },
    today: async () => ({ spent: 1, limit: 2 }),
    shouldAnnounce: () => true,
    ...over,
  });

  it('never blocks work that costs no tokens', async () => {
    const s: any = runner(budget({ runLimit: async () => 1, day: { ok: false, reason: 'used up' } }));
    // Saving a document, creating a task, searching our own notes — refusing these because the AI
    // budget is gone would be absurd. They do not use the AI.
    for (const id of ['save_document', 'create_task', 'remember', 'telegram', 'search_brain', 'search_rag', 'web_search']) {
      expect(await s.budgetStop('tool', id, 9_999_999)).toBe('');
    }
    expect(await s.budgetStop('text', undefined, 9_999_999)).toBe('');
  });

  it('stops the things that DO cost tokens', async () => {
    const s: any = runner(budget({ runLimit: async () => 1000 }));
    expect(await s.budgetStop('ask_ai', undefined, 5000)).toMatch(/reached its token budget/);
    expect(await s.budgetStop('tool', 'deep_research', 5000)).toMatch(/reached its token budget/);
    expect(await s.budgetStop('skill', 'sk1', 5000)).toMatch(/reached its token budget/);
    expect(await s.budgetStop('tool', 'gmail', 5000)).toMatch(/reached its token budget/);
  });

  it('passes on the daily reason word for word, so the owner knows which ceiling it was', async () => {
    const s: any = runner(budget({ day: { ok: false, reason: "today's AI budget is used up (500,000 of 500,000 tokens)." } }));
    expect(await s.budgetStop('ask_ai', undefined, 0)).toMatch(/today's AI budget is used up \(500,000/);
  });

  it('says the gathered work is kept, because it is', async () => {
    const s: any = runner(budget({ runLimit: async () => 10 }));
    expect(await s.budgetStop('ask_ai', undefined, 99)).toMatch(/Everything gathered so far is kept/);
  });

  it('charges an engine turn its measured average and a plain call its text', async () => {
    const s: any = runner(budget());
    expect(s.stepCost('tool', 'gmail', 'x', 'y')).toBe(118_000);      // real access, real cost
    expect(s.stepCost('skill', 'sk1', 'x', 'y')).toBe(118_000);       // skills run on the engine
    expect(s.stepCost('tool', 'save_document', 'x'.repeat(400), 'y')).toBe(0); // we just do it
    expect(s.stepCost('ask_ai', undefined, 'x'.repeat(400), 'y'.repeat(400))).toBe(200);
  });

  it('does nothing at all when no budget service is wired', async () => {
    const s: any = runner(undefined);
    expect(await s.budgetStop('ask_ai', undefined, 9_999_999)).toBe('');
  });

  it('carries on while there is room', async () => {
    const s: any = runner(budget({ runLimit: async () => 150_000 }));
    expect(await s.budgetStop('ask_ai', undefined, 1000)).toBe('');
  });
});

/** A skill that cannot run must FAIL, not quietly become an imitation of itself. */
describe('a skill never pretends (owner\'s design)', () => {
  const runner = (bridge: any, skills?: any) => new FlowRunnerService(
    {} as any, bridge, {} as any, { completeDetailed: async () => ({ text: 'IMITATION', error: null }) } as any,
    {} as any, {} as any, skills ?? { get: async () => ({ id: 'sk1', slug: 'interactive-html', deployments: '{"sandy":"interactive-html"}' }) } as any,
    {} as any, {} as any,
  );
  const node = { data: { kind: 'skill', refId: 'sk1', label: 'interactive-html' } };

  it('fails with the reason when the engine cannot run it', async () => {
    const s: any = runner({ runSkillTurn: async () => { throw new Error('every engine was unavailable'); } });
    await expect(s.runNode(node, 'the research', [])).rejects.toThrow(/interactive-html.*could not run/);
    // It must NOT have fallen through to a model imitating the skill.
    await expect(s.runNode(node, 'the research', [])).rejects.not.toThrow(/IMITATION/);
  });

  it('says so plainly when the skill is not installed at all', async () => {
    const s: any = runner({ runSkillTurn: async () => 'never called' }, { get: async () => null });
    const out = await s.runNode(node, 'x', []);
    expect(out).toMatch(/not installed on the engine/);
    expect(out).not.toBe('IMITATION');
  });

  it('returns the real skill output when it works', async () => {
    const s: any = runner({ runSkillTurn: async () => '<!doctype html><html>real skill output</html>' });
    expect(await s.runNode(node, 'x', [])).toContain('real skill output');
  });
});
