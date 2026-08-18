import { KEEP_AS_FETCHED, SOCIAL_FLOW_NOTE, argsLine, buildPlanFlow, buildSocialFlow, isDirectFetchAgent, namesFromId, wantsShaping } from './social-flow';
import { planFromAgent } from './plan';

/**
 * BEA-1366 — a Social agent's flow picture is BUILT from its settings, no AI. The node list must be
 * exactly what `SocialAgentRunService.run()` does for those settings: sources → merge (>1) → shape
 * (only when the task says more than as-fetched) → watch/alert (by mode) → writer → WhatsApp → done.
 */
const twoSources = {
  id: 'ag1',
  name: 'Smart Home India — Instagram digest',
  prompt: 'Merge all sources and de-duplicate on shortcode. Columns: creator, followers, date, likes, link.',
  tools: ['svc:instagram.search_hashtag', 'svc:instagram.reels_search'],
  toolArgs: { 'svc:instagram.search_hashtag': { hashtag: 'smarthomeindia', date_posted: 'last-month' }, 'svc:instagram.reels_search': { query: 'smart home India', date_posted: 'last-month' } },
  outputDest: 'sheet',
  sheetId: null,
  notifyWhatsApp: true,
  mode: 'run',
};
const ids = (g: any) => g.nodes.map((n: any) => n.id);
const kinds = (g: any) => g.nodes.map((n: any) => n.data.kind);
const byId = (g: any, id: string) => g.nodes.find((n: any) => n.id === id);
const edgePairs = (g: any) => g.edges.map((e: any) => `${e.source}>${e.target}`);

describe('buildSocialFlow (BEA-1366)', () => {
  it('2 sources + shaping + new sheet + WhatsApp → the exact node list, in order', () => {
    const { name, question, graph } = buildSocialFlow(twoSources, { costs: { 'svc:instagram.search_hashtag': 2 } });
    expect(ids(graph)).toEqual(['question', 'src:svc:instagram.search_hashtag', 'src:svc:instagram.reels_search', 'merge', 'shape', 'write', 'notify', 'end']);
    expect(kinds(graph)).toEqual(['question', 'tool', 'tool', 'merge', 'ask_ai', 'tool', 'tool', 'output']);
    expect(edgePairs(graph)).toEqual([
      'question>src:svc:instagram.search_hashtag', 'question>src:svc:instagram.reels_search',
      'src:svc:instagram.search_hashtag>merge', 'src:svc:instagram.reels_search>merge',
      'merge>shape', 'shape>write', 'write>notify', 'notify>end',
    ]);
    // plain English on every node, the owner's words on the question
    expect(byId(graph, 'question').data.label).toBe('Smart Home India — Instagram digest');
    expect(byId(graph, 'question').data.sub).toBe('2 Instagram sources → rows shaped your way → a new Google Sheet each run → link on WhatsApp');
    const src = byId(graph, 'src:svc:instagram.search_hashtag').data;
    expect(src.refId).toBe('svc:instagram.search_hashtag');
    expect(src.label).toBe('Instagram · Search hashtag');
    expect(src.sub).toBe('hashtag: smarthomeindia · date posted: last-month — about 2 credits per fetch');
    expect(src.args).toEqual({ hashtag: 'smarthomeindia', date_posted: 'last-month' });
    expect(src.say).toContain('no engine turn');
    // an action with no cost history says so, never guesses "1"
    expect(byId(graph, 'src:svc:instagram.reels_search').data.sub).toContain('credits per fetch: not known yet');
    expect(byId(graph, 'merge').data.modeText).toBe('Union');
    expect(byId(graph, 'merge').data.sub).toContain('the shaping step below applies your task');
    expect(byId(graph, 'shape').data.sub).toContain('Sonnet · Social rows model');
    expect(byId(graph, 'write').data.refId).toBe('svc:googlesheets.create_google_sheet1');
    expect(byId(graph, 'write').data.label).toBe('Google Sheet — new each run');
    expect(byId(graph, 'notify').data.refId).toBe('whatsapp');
    expect(byId(graph, 'end').data.kind).toBe('output');
    // the picture is marked machine-drawn, with the note the panel shows
    expect(graph.drawnBy).toBe('social');
    expect(graph.note).toBe(SOCIAL_FLOW_NOTE);
    expect(name).toBe('Smart Home India — Instagram digest — how it runs');
    expect(question).toBe(twoSources.prompt);
    // positions exist for every node (the canvas needs them)
    expect(graph.nodes.every((n: any) => n.type === 'box' && Number.isFinite(n.position?.x) && Number.isFinite(n.position?.y))).toBe(true);
  });

  it('catalog names win over names derived from the id', () => {
    const { graph } = buildSocialFlow(twoSources, { names: { 'svc:instagram.reels_search': { service: 'Instagram', action: 'Reels search (Google)' } } });
    expect(byId(graph, 'src:svc:instagram.reels_search').data.label).toBe('Instagram · Reels search (Google)');
  });

  it('as-fetched task → no shaping node; one source → no merge; document → Save to Documents; no WhatsApp → no notify', () => {
    const { graph } = buildSocialFlow({ ...twoSources, prompt: KEEP_AS_FETCHED, tools: ['svc:instagram.profile'], toolArgs: { 'svc:instagram.profile': { handle: 'beakn' } }, outputDest: 'document', notifyWhatsApp: false });
    expect(ids(graph)).toEqual(['question', 'src:svc:instagram.profile', 'write', 'end']);
    expect(byId(graph, 'write').data.refId).toBe('save_document');
    expect(edgePairs(graph)).toEqual(['question>src:svc:instagram.profile', 'src:svc:instagram.profile>write', 'write>end']);
  });

  it('watch mode adds the diff node and drops shaping (the runner never shapes a Watch)', () => {
    const { graph } = buildSocialFlow({ ...twoSources, mode: 'watch' });
    expect(ids(graph)).toEqual(['question', 'src:svc:instagram.search_hashtag', 'src:svc:instagram.reels_search', 'merge', 'watch', 'write', 'notify', 'end']);
    expect(byId(graph, 'watch').data.kind).toBe('filter');
    expect(byId(graph, 'watch').data.label).toBe('Only what changed');
    expect(byId(graph, 'question').data.sub).toContain('only what changed');
  });

  it('alert mode: an If node naming the threshold / condition, and Telegram (+ WhatsApp) after the writer', () => {
    const { graph } = buildSocialFlow({ ...twoSources, mode: 'alert', threshold: { field: 'follower_count', dir: 'above', value: 40000 }, alertCondition: 'a post mentions a price', notifyWhatsApp: false, outputDest: 'document' });
    expect(ids(graph)).toEqual(['question', 'src:svc:instagram.search_hashtag', 'src:svc:instagram.reels_search', 'merge', 'watch', 'write', 'notify', 'end']);
    const w = byId(graph, 'watch').data;
    expect(w.kind).toBe('if');
    expect(w.label).toBe('Alert when follower count goes above 40,000 or when “a post mentions a price”');
    // a fired alert goes out on BOTH roads whatever the WhatsApp toggle says — that is what the runner does
    expect(byId(graph, 'notify').data.label).toBe('Telegram + WhatsApp');
    expect(byId(graph, 'notify').data.refId).toBe('telegram');
    // an alert with nothing to judge fires on any change — the picture says that too
    const any = buildSocialFlow({ ...twoSources, mode: 'alert', notifyWhatsApp: true }).graph;
    expect(byId(any, 'watch').data.label).toBe('Alert on any change');
    expect(byId(any, 'notify').data.label).toBe('Telegram + WhatsApp');
  });

  it('two sources as fetched: the merge is a union de-duped on the item id (BEA-1374) — no shaping node', () => {
    const { graph } = buildSocialFlow({ ...twoSources, prompt: KEEP_AS_FETCHED });
    expect(ids(graph)).toEqual(['question', 'src:svc:instagram.search_hashtag', 'src:svc:instagram.reels_search', 'merge', 'write', 'notify', 'end']);
    expect(byId(graph, 'merge').data.sub).toContain('de-duped on its id');
    expect(byId(graph, 'merge').data.say).toMatch(/de-duped on the item id/);
  });

  it('append mode names the owner’s sheet and the batch_update action', () => {
    const { graph } = buildSocialFlow({ ...twoSources, sheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz' });
    expect(byId(graph, 'write').data.refId).toBe('svc:googlesheets.batch_update');
    expect(byId(graph, 'write').data.label).toBe('Google Sheet — append to yours');
    expect(byId(graph, 'question').data.sub).toContain('appended to your Google Sheet');
  });

  it('is deterministic — same settings, same graph', () => {
    expect(JSON.stringify(buildSocialFlow(twoSources).graph)).toBe(JSON.stringify(buildSocialFlow({ ...twoSources }).graph));
  });
});

describe('the shared Social facts (moved here from the runner)', () => {
  it('isDirectFetchAgent: every tool a svc: id with pinned args', () => {
    expect(isDirectFetchAgent(twoSources)).toBe(true);
    expect(isDirectFetchAgent({ ...twoSources, toolArgs: null })).toBe(false);
    expect(isDirectFetchAgent({ ...twoSources, tools: ['web_search'] })).toBe(false);
    expect(isDirectFetchAgent({ ...twoSources, tools: [] })).toBe(false);
  });
  it('wantsShaping: only when the task says more than "as fetched"', () => {
    expect(wantsShaping(KEEP_AS_FETCHED)).toBe(false);
    expect(wantsShaping('keep every result as fetched')).toBe(false);
    expect(wantsShaping('')).toBe(false);
    expect(wantsShaping('Columns: creator, link')).toBe(true);
  });
  it('helpers read well', () => {
    expect(namesFromId('svc:instagram.search_hashtag')).toEqual({ service: 'Instagram', action: 'Search hashtag' });
    expect(namesFromId('svc:googlesheets.create_google_sheet1').action).toBe('Create google sheet');
    expect(argsLine({ hashtag: 'x', empty: '', n: 3 })).toBe('hashtag: x · n: 3');
  });

  // ---- BEA-1369: the picture is drawn from the plan ---------------------------------------------
  it('a paged source says "× N pages" and its cost per run; the picture is the plan\'s picture', () => {
    const paged = { ...twoSources, toolArgs: { ...twoSources.toolArgs, 'svc:instagram.search_hashtag': { hashtag: 'smarthomeindia', date_posted: 'last-month', _pages: 8 } } };
    const { graph } = buildSocialFlow(paged, { costs: { 'svc:instagram.search_hashtag': 1 } });
    const src = byId(graph, 'src:svc:instagram.search_hashtag').data;
    expect(src.label).toBe('Instagram · Search hashtag × 8 pages');
    expect(src.sub).toBe('hashtag: smarthomeindia · date posted: last-month — about 8 credits per run (8 pages × 1)');
    expect(src.args).toEqual({ hashtag: 'smarthomeindia', date_posted: 'last-month', _pages: 8 });
    expect(src.say).toContain('up to 8 pages');
    // no cost history → says so, still names the pages
    expect(buildSocialFlow(paged).graph.nodes.find((n: any) => n.id === 'src:svc:instagram.search_hashtag').data.sub).toContain('credits per page: not known yet (8 pages)');
    // the same graph from the plan directly
    expect(buildPlanFlow(planFromAgent(paged), { costs: { 'svc:instagram.search_hashtag': 1 } })).toEqual(buildSocialFlow(paged, { costs: { 'svc:instagram.search_hashtag': 1 } }));
  });

  it('a creators-first block is ONE node, "Find creators → their posts", with the finder, N, the per-creator action and the days', () => {
    const agent = {
      id: 'ag3', name: 'India creators', prompt: KEEP_AS_FETCHED, outputDest: 'document', mode: 'run',
      tools: ['svc:instagram.search_profiles'],
      toolArgs: { 'svc:instagram.search_profiles': { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' }, take: 5 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, keepDays: 30 } } },
    };
    const { graph } = buildSocialFlow(agent, { names: { 'svc:instagram.search_profiles': { service: 'Instagram', action: 'Search Instagram Profiles' }, 'svc:instagram.user_posts': { service: 'Instagram', action: 'Posts' } }, costs: { 'svc:instagram.search_profiles': 1, 'svc:instagram.user_posts': 1 } });
    expect(ids(graph)).toEqual(['question', 'src:svc:instagram.search_profiles', 'write', 'end']);
    const n = byId(graph, 'src:svc:instagram.search_profiles').data;
    expect(n.kind).toBe('tool');
    expect(n.refId).toBe('svc:instagram.search_profiles');
    expect(n.label).toBe('Find creators → their posts');
    expect(n.sub).toBe('Search Instagram Profiles (query: smart home india) → first 5 → Posts each · last 30 days — about 6 credits per run (1 + 5 × 1)');
    expect(n.say).toContain('handle ← username');
    expect(n.say).toContain('a creator that fails is said and skipped');
    expect(byId(graph, 'question').data.sub).toBe('1 Instagram source → rows as fetched → saved to Documents');
  });
});

/**
 * BEA-1374 — sources keyed by source id: five hashtag sources on ONE action are five nodes, each
 * labelled with its hashtag; "keep adding" draws the one-sheet writer.
 */
describe('several sources on one action + keep adding (BEA-1374)', () => {
  const HASHTAGS = ['smarthomeindia', 'homeautomationindia', 'smarthome', 'homeautomation', 'smartlighting'];
  const five = (over: any = {}) => {
    const toolArgs: Record<string, any> = {};
    HASHTAGS.forEach((h, i) => { toolArgs[i ? `svc:instagram.search_hashtag#${i + 1}` : 'svc:instagram.search_hashtag'] = { actionId: 'svc:instagram.search_hashtag', args: { hashtag: h }, _pages: 3 }; });
    return { id: 'ag5', name: 'Five hashtags', tools: ['svc:instagram.search_hashtag'], toolArgs, prompt: KEEP_AS_FETCHED, outputDest: 'sheet', sheetId: null, ...over };
  };
  const names = { 'svc:instagram.search_hashtag': { service: 'Instagram', action: 'Search Hashtag Posts' } };

  it('five nodes, one per source, each naming its hashtag and pages — the same node ids the runner badges', () => {
    const { graph } = buildSocialFlow(five(), { names });
    expect(ids(graph)).toEqual(['question', 'src:svc:instagram.search_hashtag', 'src:svc:instagram.search_hashtag#2', 'src:svc:instagram.search_hashtag#3', 'src:svc:instagram.search_hashtag#4', 'src:svc:instagram.search_hashtag#5', 'merge', 'write', 'end']);
    expect(byId(graph, 'src:svc:instagram.search_hashtag').data.label).toBe('Instagram · Search Hashtag Posts #smarthomeindia × 3 pages');
    expect(byId(graph, 'src:svc:instagram.search_hashtag#2').data.label).toBe('Instagram · Search Hashtag Posts #homeautomationindia × 3 pages');
    expect(byId(graph, 'src:svc:instagram.search_hashtag#5').data.args).toEqual({ hashtag: 'smartlighting', _pages: 3 });
    expect(byId(graph, 'question').data.sub).toBe('5 Instagram sources → rows as fetched → a new Google Sheet each run');
    // a lone action keeps its plain label — exactly as before
    const one = buildSocialFlow({ ...five(), toolArgs: { 'svc:instagram.search_hashtag': { hashtag: 'smarthome' } } }, { names });
    expect(byId(one.graph, 'src:svc:instagram.search_hashtag').data.label).toBe('Instagram · Search Hashtag Posts');
  });

  it('"keep adding" (sheetAppend, no sheet yet) → the one-sheet writer; once the runner remembered the sheet → append to yours', () => {
    const { graph } = buildSocialFlow(five({ sheetAppend: true }), { names });
    expect(byId(graph, 'write').data.label).toBe('Google Sheet — one sheet, kept adding to');
    expect(byId(graph, 'write').data.refId).toBe('svc:googlesheets.batch_update');
    expect(byId(graph, 'write').data.sub).toMatch(/Made on the first run \(titled "Five hashtags"\)/);
    expect(byId(graph, 'question').data.sub).toContain('kept adding to one Google Sheet');
    const later = buildSocialFlow(five({ sheetAppend: true, sheetId: 'SHEET_ONE' }), { names });
    expect(byId(later.graph, 'write').data.label).toBe('Google Sheet — append to yours');
    expect(byId(later.graph, 'write').data.sub).toMatch(/rows already there \(by id\) are skipped/);
  });
});
