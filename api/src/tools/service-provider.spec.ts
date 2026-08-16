import {
  BLOCKED_SERVICES,
  isBlockedService,
  isRiskyAction,
  isServiceToolId,
  parseServiceToolId,
  serviceToolId,
  SERVICE_TOOL_ID_RE,
  toolIdFromVendorSlug,
  vendorActionSlug,
} from './service-provider';

/**
 * The seam's ids (BEA-1345).
 *
 * These are load-bearing twice over: the flow executor dispatches on them, and they are stored
 * inside flows already saved in the database. If the round-trip ever stops being exact, a saved
 * flow silently calls the wrong action — or nothing at all.
 */
describe('service tool ids', () => {
  it('round-trips our id to the vendor slug and back', () => {
    expect(vendorActionSlug('svc:github.create_issue')).toBe('GITHUB_CREATE_ISSUE');
    expect(toolIdFromVendorSlug('github', 'GITHUB_CREATE_ISSUE')).toBe('svc:github.create_issue');
    expect(toolIdFromVendorSlug('github', vendorActionSlug('svc:github.create_issue')!)).toBe('svc:github.create_issue');
  });

  it('round-trips a service whose own slug contains an underscore', () => {
    // 106 of the first 500 toolkits look like this (google_maps, microsoft_teams) — a naive
    // "cut at the first underscore" would eat half the service name.
    expect(vendorActionSlug('svc:google_maps.get_directions')).toBe('GOOGLE_MAPS_GET_DIRECTIONS');
    expect(toolIdFromVendorSlug('google_maps', 'GOOGLE_MAPS_GET_DIRECTIONS')).toBe('svc:google_maps.get_directions');
  });

  it('does not double the service prefix when the action already carries it', () => {
    expect(vendorActionSlug('svc:linear.linear_create_issue')).toBe('LINEAR_CREATE_ISSUE');
  });

  it('accepts only the one shape, and the shape the catalog promises', () => {
    for (const id of ['svc:github.create_issue', 'svc:google_maps.get_directions', 'svc:slack.send_message']) {
      expect(isServiceToolId(id)).toBe(true);
      expect(SERVICE_TOOL_ID_RE.test(id)).toBe(true);
    }
    for (const id of ['search_brain', 'svc:GitHub.create_issue', 'svc:github', 'composio:github.create_issue', 'svc:github.create-issue', '']) {
      expect(isServiceToolId(id)).toBe(false);
      expect(vendorActionSlug(id)).toBeNull();
    }
  });

  it('parses an id back into its parts', () => {
    expect(parseServiceToolId('svc:notion.create_page')).toEqual({ service: 'notion', action: 'create_page' });
    expect(parseServiceToolId('not_an_id')).toBeNull();
  });

  it('never puts a vendor name in an id', () => {
    expect(serviceToolId('github', 'CREATE_ISSUE')).toBe('svc:github.create_issue');
    expect(serviceToolId('github', 'CREATE_ISSUE')).not.toMatch(/composio/i);
  });
});

/** We already do these better, or they are ours. Routing them outside would cost control and money. */
describe('blocked services', () => {
  it('blocks exactly the six from the design', () => {
    expect([...BLOCKED_SERVICES].sort()).toEqual(['exa', 'firecrawl', 'perplexity', 'tavily', 'telegram', 'whatsapp']);
  });

  it('blocks whatever case they arrive in', () => {
    for (const s of ['exa', 'Firecrawl', 'TAVILY', 'perplexity', 'Telegram', 'whatsapp']) {
      expect(isBlockedService(s)).toBe(true);
    }
  });

  it('does NOT block Google — it moves over on purpose', () => {
    for (const s of ['gmail', 'googledrive', 'googlecalendar', 'github', 'slack', 'linear', 'notion']) {
      expect(isBlockedService(s)).toBe(false);
    }
  });
});

/** Flagging only — the pause-and-ask gate itself is BEA-1348. */
describe('actions that cannot be undone', () => {
  it('flags the rule matches', () => {
    for (const slug of ['GITHUB_DELETE_A_REPOSITORY', 'SLACK_REMOVE_A_USER', 'GITHUB_MERGE_A_PULL_REQUEST', 'STRIPE_REFUND_A_CHARGE', 'GITHUB_ADD_A_REPOSITORY_COLLABORATOR']) {
      expect(isRiskyAction(slug, slug.split('_')[0].toLowerCase())).toBe(true);
    }
    expect(isRiskyAction('svc:github.delete_a_repository')).toBe(true);
  });

  it('leaves ordinary reads alone', () => {
    expect(isRiskyAction('GITHUB_LIST_REPOSITORIES', 'github')).toBe(false);
    expect(isRiskyAction('svc:gmail.fetch_emails')).toBe(false);
  });
});
