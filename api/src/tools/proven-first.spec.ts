import { rankActions, shortlistForPrompt, type ShortlistTool } from './tool-shortlist';
import { RULES_TEXT } from '../agent/thinking-builder';
import { CHOOSE_TOOLS_RULE } from '../agent/prompt-rules';

/**
 * The builder picks its own tools, and prefers what has actually worked (BEA-1542).
 *
 * He created an agent and it asked him: *"Which connected tools should the agent use to search
 * Reddit, create the Google Sheet, and send you the WhatsApp message?"* — a question he cannot
 * usefully answer (he does not know the ids) and which his own tool-call log had already answered:
 * `svc:reddit.subreddit` had succeeded 35 times, `svc:googlesheets.create_google_sheet1` three, and
 * `svc:whatsapp.send_text` twice.
 *
 * Two reasons it asked, and both are fixed here:
 *  - nothing in its rules told it to choose tools itself, while a dozen rules told it to ask;
 *  - ranking was keyword-and-flag only, so an action nobody has ever run could sit above one with a
 *    track record. Two providers both offer a service called `reddit` — one is an integration he
 *    never linked, the other has served every real call — and a name match cannot tell them apart.
 */
const t = (id: string, over: Partial<ShortlistTool> = {}): ShortlistTool => ({ id, name: id.split('.').pop() || id, service: id.split(':')[1]?.split('.')[0], ...over });

describe('proven actions rank first', () => {
  it('puts a proven action above a better-worded one that has never run', () => {
    const out = rankActions(
      [t('svc:reddit.search_posts_by_keyword'), t('svc:reddit.subreddit', { proven: 35 })],
      'search reddit posts by keyword',
    );
    expect(out[0].id).toBe('svc:reddit.subreddit');
  });

  it('orders several proven actions by how much they have worked', () => {
    const out = rankActions(
      [t('svc:a.one', { proven: 2 }), t('svc:a.two', { proven: 35 }), t('svc:a.three', { proven: 9 })],
      'anything',
    );
    expect(out.map((x) => x.id)).toEqual(['svc:a.two', 'svc:a.three', 'svc:a.one']);
  });

  // A retired action that once worked is still retired — proven must not resurrect it.
  it('never lifts a retired action above a live one', () => {
    const out = rankActions([t('svc:a.old', { proven: 99, retired: true }), t('svc:a.new')], 'anything');
    expect(out[0].id).toBe('svc:a.new');
  });

  it('falls back to the old order when nothing has a record', () => {
    const out = rankActions([t('svc:a.zebra'), t('svc:a.search_posts')], 'search posts');
    expect(out[0].id).toBe('svc:a.search_posts'); // keyword match still decides
  });

  it('carries proven through the whole-prompt shortlist', () => {
    const out = shortlistForPrompt(
      [t('svc:reddit.post'), t('svc:reddit.subreddit', { proven: 35 })],
      'reddit',
      40,
    );
    expect(out[0].id).toBe('svc:reddit.subreddit');
  });

  it('treats a zero count as no record, not as a win', () => {
    const out = rankActions([t('svc:a.never', { proven: 0 }), t('svc:a.search'), ], 'search');
    expect(out[0].id).toBe('svc:a.search');
  });
});

describe('the builder is told to choose tools itself', () => {
  // Assert the rule is CARRIED, not how it is worded — the wording lives in one place now
  // (BEA-1544) and a test that pins the prose would break every time it is improved.
  it('carries the shared tool-choice rule', () => {
    expect(RULES_TEXT).toContain(CHOOSE_TOOLS_RULE);
  });

  // The point is not silence — he should still be told what it picked, in words he recognises.
  it('still requires it to say what it chose, in plain words', () => {
    expect(CHOOSE_TOOLS_RULE).toMatch(/name your choice/i);
  });

  // And it must not go silent when nothing can do the job — that is a real thing to say.
  it('says so plainly when nothing shown can do a part of it', () => {
    expect(CHOOSE_TOOLS_RULE).toMatch(/say that plainly instead of asking him to pick/i);
  });
});
