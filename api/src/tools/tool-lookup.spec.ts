import { describe, expect, it } from '@jest/globals';
import { FIND_MAX, LOOKUP_TEXT, ToolLookupService, lookupRequestOf, lookupText } from './tool-lookup.service';

/**
 * The builder asks for its own tools (BEA-1417).
 *
 * His idea: *"Codex will contact the RAG to pull all the tools and the necessary actions required…
 * when it has complete information, it can easily build the agent."* The instinct is right and the
 * store is wrong — a RAG answers with the most *similar* thing, and "send a message" is similar to
 * `delete_message`. So: exact lookup, and one rule that makes it safe.
 *
 * **A search narrows. Only an exact fetch may be planned on.**
 */

const TOOLS = [
  { id: 'svc:gmail.fetch_emails', name: 'Fetch emails', description: 'Read messages from a mailbox', service: 'gmail', connected: true },
  { id: 'svc:gmail.send_email', name: 'Send email', description: 'Send a message', service: 'gmail', connected: true, risky: true },
  { id: 'svc:gmail.create_draft', name: 'Create a draft', description: 'Save a draft message', service: 'gmail', connected: true },
  { id: 'svc:gmail.delete_draft', name: 'Delete a draft', description: 'Remove a draft', service: 'gmail', connected: true, risky: true, retired: true },
  { id: 'svc:googlesheets.batch_update', name: 'Write cells', description: 'Write to a sheet', service: 'googlesheets', connected: true },
  { id: 'svc:notion.create_page', name: 'Create page', description: 'Make a page', service: 'notion', connected: false },
  { id: 'search_brain', name: 'Search my brain', description: 'Everything you saved', connected: true },
];

function svc(over: any = {}) {
  const catalog: any = { catalog: async () => ({ tools: TOOLS }) };
  const knowledge: any = { card: async (id: string) => (id === 'svc:gmail.fetch_emails' ? { actionId: id, name: 'Gmail · Fetch emails' } : null) };
  const s = new ToolLookupService(catalog, over.knowledge === undefined ? knowledge : over.knowledge);
  s.setCardWriter((c: any) => `CARD for ${c.actionId} (${c.name})`);
  return s;
}

describe('what is connected', () => {
  it('lists only connected outside services, with their counts', async () => {
    const list = await svc().services();
    expect(list.map((s) => s.slug)).toEqual(['gmail', 'googlesheets']);
    expect(list.find((s) => s.slug === 'gmail')!.actions).toBe(4);
    // Notion is not connected; the brain's own tools are not outside services.
    expect(list.map((s) => s.slug)).not.toContain('notion');
  });

  it('gives a service a readable name', async () => {
    expect((await svc().services()).find((s) => s.slug === 'googlesheets')!.name).toBe('Googlesheets');
  });
});

describe('finding an action — narrowing only', () => {
  it('finds what the words describe', async () => {
    const found = await svc().findActions('gmail', 'send a draft');
    expect(found.map((a) => a.id)).toContain('svc:gmail.create_draft');
    expect(found.map((a) => a.id)).toContain('svc:gmail.send_email');
  });

  it('marks what would need his approval, so a plan cannot be surprised by it', async () => {
    const found = await svc().findActions('gmail', 'send');
    expect(found.find((a) => a.id === 'svc:gmail.send_email')!.risky).toBe(true);
  });

  it('puts a retired action last, and still shows it — it is real and still callable', async () => {
    const found = await svc().findActions('gmail', 'draft');
    const ids = found.map((a) => a.id);
    expect(ids).toContain('svc:gmail.delete_draft');
    expect(ids.indexOf('svc:gmail.delete_draft')).toBeGreaterThan(ids.indexOf('svc:gmail.create_draft'));
  });

  it('answers NAMES only — never a schema, because a search may not be planned on', async () => {
    const found = await svc().findActions('gmail', 'emails');
    for (const a of found) expect(Object.keys(a).sort()).toEqual(expect.arrayContaining(['id', 'name']));
    expect(JSON.stringify(found)).not.toContain('parameters');
  });

  it('never wanders past its cap', async () => {
    expect(FIND_MAX).toBeLessThanOrEqual(25);
    expect((await svc().findActions('gmail', '')).length).toBeLessThanOrEqual(FIND_MAX);
  });

  it('says nothing rather than guessing when a service is not named', async () => {
    expect(await svc().findActions('', 'send')).toEqual([]);
  });
});

describe('fetching one action in full', () => {
  it('answers the whole card — the only thing a plan may be built on', async () => {
    const got = await svc().getAction('svc:gmail.fetch_emails');
    expect(got!.id).toBe('svc:gmail.fetch_emails');
    expect(got!.text).toContain('CARD for svc:gmail.fetch_emails');
  });

  it('answers nothing for an action that does not exist', async () => {
    expect(await svc().getAction('svc:gmail.nonsense')).toBeNull();
  });

  it('refuses anything that is not an outside-service id', async () => {
    expect(await svc().getAction('search_brain')).toBeNull();
    expect(await svc().getAction('')).toBeNull();
  });
});

describe('reading the model\'s request', () => {
  it('reads all three questions', () => {
    expect(lookupRequestOf({ lookup: { what: 'services' } })).toEqual({ what: 'services' });
    expect(lookupRequestOf({ lookup: { what: 'actions', service: 'gmail', words: 'send' } })).toEqual({ what: 'actions', service: 'gmail', words: 'send' });
    expect(lookupRequestOf({ lookup: { what: 'action', actionId: 'svc:gmail.send_email' } })).toEqual({ what: 'action', actionId: 'svc:gmail.send_email' });
  });

  it('ignores anything else', () => {
    expect(lookupRequestOf({})).toBeNull();
    expect(lookupRequestOf({ lookup: { what: 'everything' } })).toBeNull();
    expect(lookupRequestOf({ lookup: 'gmail' })).toBeNull();
  });
});

describe('what the model reads back', () => {
  it('tells it plainly that a search may not be planned on', () => {
    const text = lookupText({ what: 'actions', service: 'gmail', words: 'send' }, { actions: [{ id: 'svc:gmail.send_email', name: 'Send email', risky: true }] });
    expect(text).toContain('names only');
    expect(text).toContain('fetch one in full before planning on it');
    expect(text).toContain('needs his approval to run');
  });

  it('says what to do next when a search finds nothing', () => {
    const text = lookupText({ what: 'actions', service: 'gmail', words: 'telepathy' }, { actions: [] });
    expect(text).toContain('nothing in "gmail" matches');
    expect(text).toContain('Try other words');
  });

  it('says what to do when nothing is connected at all', () => {
    expect(lookupText({ what: 'services' }, { services: [] })).toContain('connect a service in /tools');
  });

  it('sends it back to search when it asked for an action that is not there', () => {
    expect(lookupText({ what: 'action', actionId: 'svc:x.y' }, { action: null })).toContain('Search the service first');
  });

  it('the instructions say the rule out loud', () => {
    expect(LOOKUP_TEXT).toContain('a search only narrows');
    expect(LOOKUP_TEXT).toContain('a plan\nthat names an id you never fetched is refused');
    expect(LOOKUP_TEXT).toContain('Do not fetch twenty to browse');
  });
});
