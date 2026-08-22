import {
  argsHashOf,
  maskText,
  isUsable,
  maskPayload,
  MASK,
  RAW_MAX,
  SAMPLE_MAX_BYTES,
  PER_ACTION_GOOD,
  PER_AGENT_FAILING,
  SAMPLE_PROVIDER,
  SECRET_MASK,
  shouldSample,
  TOTAL_BUDGET_MB,
  truncatedNote,
} from './tool-sample';

/**
 * The masker is the part of BEA-1386 that keeps other people's personal data out of a store we will
 * still have in a year. `redact()` cannot do this job — it cuts at 4,000 characters and masks by key
 * NAME only — so these tests are written against the shapes a real vendor answer carries.
 */
describe('maskPayload', () => {
  // One fixture with every shape the brief names: an e-mail, an E.164 number, a bare 12-digit
  // number, a caption (personal data in the middle of free text) and a key called `token`.
  const answer = {
    success: true,
    token: 'sk-live-abcdef123456',
    user: {
      pk: '51242237037',
      username: 'smart_home_india',
      email: 'sandy@example.com',
      phone: '+91 90006 07141',
      biography: 'Smart homes. Reach me on 919000607141, WhatsApp 98765 43210 or sandy@example.com',
      follower_count: 18234,
    },
    items: [
      {
        id: '3456789012345678901',
        shortcode: 'C4xYz9AbCdE',
        taken_at: 1755800000,
        caption: { text: 'Order now — call +919000607141, mail us at sales@example.co.in, ref 919000607142' },
        like_count: 431,
      },
    ],
  };

  const masked = maskPayload(answer);

  it('masks a key named token, whatever its value looks like', () => {
    expect(masked.token).toBe(SECRET_MASK);
  });

  it('masks an e-mail wherever it appears — its own field, a bio, a caption', () => {
    expect(masked.user.email).toBe(MASK);
    expect(masked.user.biography).not.toContain('sandy@example.com');
    expect(masked.items[0].caption.text).not.toContain('sales@example.co.in');
  });

  it('masks an E.164 number and a bare 12-digit number, in a field and inside a caption', () => {
    expect(masked.user.phone).toBe(MASK);
    expect(masked.user.biography).not.toContain('919000607141');
    const caption = masked.items[0].caption.text;
    expect(caption).not.toContain('+919000607141');
    expect(caption).not.toContain('919000607142');
    expect(caption).toContain('Order now');
  });

  it('masks a phone number however a bio spaces it out — the everyday format, no leading +', () => {
    expect(masked.user.biography).not.toContain('98765 43210');
    expect(maskText('DM me: 98765 43210 for business')).toBe(`DM me: ${MASK} for business`);
    expect(maskText('Call 9876-543-210 now')).toBe(`Call ${MASK} now`);
    expect(maskText('Ring (080) 4567 8901')).toContain(MASK);
    // …and leaves what is not a phone number alone: a year, a price, a long media id.
    expect(maskText('Since 2019 we have sold 1.250 units')).toBe('Since 2019 we have sold 1.250 units');
    expect(maskText('post 3456789012345678901 did well')).toBe('post 3456789012345678901 did well');
  });

  it('keeps the structure, the types and the fields a worker actually tests against', () => {
    expect(masked.success).toBe(true);
    expect(Array.isArray(masked.items)).toBe(true);
    expect(masked.user.username).toBe('smart_home_india');
    expect(masked.user.follower_count).toBe(18234);
    expect(masked.items[0].like_count).toBe(431);
    // Ids and dates survive on purpose: a worker de-dupes on the id and filters on the date, and a
    // masked id or a masked timestamp would make the stored answer useless.
    expect(masked.items[0].id).toBe('3456789012345678901');
    expect(masked.user.pk).toBe('51242237037');
    expect(masked.items[0].taken_at).toBe(1755800000);
    expect(masked.items[0].shortcode).toBe('C4xYz9AbCdE');
  });

  it('has no length cap — the whole answer is masked, not the first 4,000 characters', () => {
    const long = { items: Array.from({ length: 400 }, (_, i) => ({ id: String(i), caption: `call 919000607141 #${i}` })) };
    const out = maskPayload(long);
    expect(JSON.stringify(out).length).toBeGreaterThan(4000);
    expect(JSON.stringify(out)).not.toContain('919000607141');
    expect(out.items[399].id).toBe('399');
  });

  it('masks a phone-shaped value under a personal key even when it arrives as a number', () => {
    const out = maskPayload({ contact_number: 919000607141, wa_id: '919000607141', from: 'sandy@example.com' });
    expect(out.contact_number).toBe(0);
    expect(out.wa_id).toBe(MASK);
    expect(out.from).toBe(MASK);
  });

  it('leaves null, undefined and empty answers alone', () => {
    expect(maskPayload(null)).toBeNull();
    expect(maskPayload([])).toEqual([]);
    expect(maskPayload('plain text')).toBe('plain text');
  });
});

describe('argsHashOf', () => {
  it('is the same for the same call however the keys are ordered', () => {
    expect(argsHashOf({ a: 1, b: { c: 2, d: 3 } })).toBe(argsHashOf({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('is different for a different call', () => {
    expect(argsHashOf({ hashtag: 'smarthomeindia' })).not.toBe(argsHashOf({ hashtag: 'smarthome' }));
  });

  it('never carries a secret into the hash input', () => {
    expect(argsHashOf({ token: 'sk-live-1' })).toBe(argsHashOf({ token: 'sk-live-2' }));
  });
});

describe('shouldSample', () => {
  const read = { ok: true, readOnly: true, providerKind: SAMPLE_PROVIDER };

  it('keeps a successful read of an opted-in social service', () => {
    expect(shouldSample({ actionId: 'svc:instagram.search_hashtag', ...read })).toBe(true);
    expect(shouldSample({ actionId: 'svc:youtube.channel_videos', ok: true, method: 'GET', providerKind: SAMPLE_PROVIDER })).toBe(true);
  });

  it('never samples the Vault or anything that can carry messages', () => {
    expect(shouldSample({ actionId: 'svc:vault.get_secret', ...read })).toBe(false);
    expect(shouldSample({ actionId: 'svc:whatsapp.get_conversation', ...read })).toBe(false);
    expect(shouldSample({ actionId: 'svc:gmail.fetch_emails', ...read })).toBe(false);
    expect(shouldSample({ actionId: 'svc:instagram.direct_messages', ...read })).toBe(false);
    expect(shouldSample({ actionId: 'svc:instagram.inbox', ...read })).toBe(false);
  });

  it('is opt-in: a service nobody added is not sampled, however harmless it looks', () => {
    expect(shouldSample({ actionId: 'svc:googlesheets.batch_get', ...read })).toBe(false);
    expect(shouldSample({ actionId: 'svc:github.list_issues', ...read })).toBe(false);
  });

  it('never samples a failure, a gated call or a write', () => {
    expect(shouldSample({ ...read, actionId: 'svc:instagram.search_hashtag', ok: false })).toBe(false);
    expect(shouldSample({ ...read, actionId: 'svc:instagram.search_hashtag', gated: true })).toBe(false);
    expect(shouldSample({ actionId: 'svc:instagram.post_comment', ok: true, method: 'POST', providerKind: SAMPLE_PROVIDER })).toBe(false);
    expect(shouldSample({ actionId: 'not-a-service-id', ...read })).toBe(false);
  });

  it('never samples the same slug when a DIFFERENT provider answered it', () => {
    // The general provider's `twitter` is the owner's own signed-in account: reading his followers
    // is his address book, not public content, and the slug alone must never open the store.
    expect(shouldSample({ actionId: 'svc:twitter.followers', ok: true, readOnly: true })).toBe(false);
    expect(shouldSample({ actionId: 'svc:twitter.followers', ok: true, readOnly: true, providerKind: 'other' })).toBe(false);
  });

  it('keeps the platform called Threads — a post is not a conversation', () => {
    expect(shouldSample({ actionId: 'svc:threads.user_posts', ...read })).toBe(true);
  });
});

describe('the caps', () => {
  it('are the numbers the design names, in one place', () => {
    expect(RAW_MAX).toBe(256 * 1024);
    expect(SAMPLE_MAX_BYTES).toBe(1024 * 1024);
    expect(PER_ACTION_GOOD).toBe(5);
    expect(PER_AGENT_FAILING).toBe(10);
    expect(TOTAL_BUDGET_MB).toBe(100);
  });

  it('mark a truncated sample as not usable for tests', () => {
    expect(isUsable({ note: null })).toBe(true);
    expect(isUsable({ note: 'kept after a failure' })).toBe(true);
    expect(isUsable({ note: truncatedNote(3 * 1024 * 1024) })).toBe(false);
  });
});
