import { buildActivity, kindOf, serviceOf, verbOf } from './build-activity';

/**
 * WHAT A BUILD TOUCHED (BEA-1492).
 *
 * A build may now make any call at all — read, create, send, delete. He chose that twice, with the
 * consequence spelled out. What was missing beside it was any way for HIM to see what a build did:
 * the calls went to his ledger with an empty run id, so the only way to answer "what did that build
 * touch?" was for me to query the database. Freedom without visibility is just hoping.
 */
describe('a build says what it touched, in his words', () => {
  it('groups by what the call DID, worst first', () => {
    const a = buildActivity([
      { action: 'svc:gmail.fetch_emails', ok: true },
      { action: 'svc:gmail.fetch_emails', ok: true },
      { action: 'svc:notion.create_notion_page', ok: true },
      { action: 'svc:notion.archive_notion_page', ok: true },
    ]);
    expect(a.total).toBe(4);
    // A delete is the thing he most needs to see, so it leads.
    expect(a.lines[0]).toContain('deleted or archived');
    expect(a.lines[a.lines.length - 1]).toContain('read');
    expect(a.lines.join('\n')).toContain('Gmail ×2');
    expect(a.changed).toBe(true);
  });

  it('says plainly when a build never tried anything', () => {
    // The build that worried me: v6 made ZERO calls and trusted the document. A build that never
    // looked is exactly the one to distrust, so silence must not read as "nothing to report".
    const a = buildActivity([]);
    expect(a.total).toBe(0);
    expect(a.lines[0]).toContain('did not try anything');
    expect(a.changed).toBe(false);
  });

  it('counts failures beside the kind, rather than hiding them', () => {
    const a = buildActivity([
      { action: 'svc:notion.create_notion_page', ok: false, error: 'parent_id missing' },
      { action: 'svc:notion.create_notion_page', ok: true },
    ]);
    expect(a.lines[0]).toContain('(1 failed)');
    expect(a.failed).toBe(1);
  });

  it('a read-only build is not marked as having changed anything', () => {
    const a = buildActivity([{ action: 'svc:gmail.fetch_emails', ok: true }]);
    expect(a.changed).toBe(false);
  });
});

describe('reading an action id', () => {
  it('splits service from verb', () => {
    expect(serviceOf('svc:notion.create_notion_page')).toBe('Notion');
    expect(verbOf('svc:notion.create_notion_page')).toBe('create_notion_page');
  });

  it('reads the worse meaning when a name carries two', () => {
    // `delete_draft_message` is a delete, not a message — the ordering is the whole point.
    expect(kindOf('svc:gmail.delete_draft_message')).toBe('deleted');
    expect(kindOf('svc:whatsapp.send_text')).toBe('sent');
    expect(kindOf('svc:notion.update_page')).toBe('changed');
    expect(kindOf('svc:gmail.fetch_emails')).toBe('read');
  });
});
