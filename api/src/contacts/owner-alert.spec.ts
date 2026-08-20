import {
  buttonSuffix, flat, NOT_APPROVED_NOTE, OWNER_RESULT_TEMPLATE, OWNER_TEMPLATE, ownerFirstName, REFUSED_ON_TELEGRAM,
  sendOwnerAlert, setOwnerAlertTelegram, templateUnusable, VERDICT, whatsappStepLabel, withoutLinks,
} from './owner-alert';

/** BEA-1362 — the one road to the owner's phone: template first, free text never alone. */
function box(opts: {
  template?: { status: string; error?: string; wamid?: string; id?: string };
  /** Per-template-name verdicts (BEA-1379 chain tests) — wins over `template`. */
  templateByName?: Record<string, { status: string; error?: string; wamid?: string; id?: string }>;
  text?: { status: string; error?: string };
  configured?: boolean;
  /** Meta's real verdict per poll (BEA-1379); each call shifts one off. Absent = an old stub with no status route. */
  statuses?: ({ status?: string; error?: string | null } | null)[];
} = {}) {
  const calls: any[] = [];
  const statusCalls: string[] = [];
  const postbox: any = {
    isConfigured: () => opts.configured !== false,
    sendTemplate: async (to: string, name: string, variables: string[], o: any) => {
      calls.push({ kind: 'template', to, name, variables, buttonUrl: o?.buttonUrl });
      return opts.templateByName?.[name] || opts.template || { status: 'sent', wamid: 'wamid.T' };
    },
    sendText: async (to: string, body: string) => { calls.push({ kind: 'text', to, body }); return opts.text || { status: 'sent', wamid: 'wamid.X' }; },
  };
  if (opts.statuses) postbox.messageStatus = async (id: string) => { statusCalls.push(id); return opts.statuses!.length ? opts.statuses!.shift()! : null; };
  return { calls, statusCalls, postbox };
}

beforeAll(() => { VERDICT.waitMs = 0; }); // no real 8 s waits in tests
afterEach(() => setOwnerAlertTelegram(null)); // never leak a registered Telegram between tests

describe('flat() — what a template variable may hold', () => {
  it('folds newlines to " · ", squeezes spaces, cuts with an ellipsis', () => {
    expect(flat('a\n\nb\n  c   d\t', 100)).toBe('a · b · c d');
    expect(flat('x'.repeat(50), 10)).toHaveLength(10);
    expect(flat('x'.repeat(50), 10).endsWith('…')).toBe(true);
    expect(flat(null, 10)).toBe('');
  });
});

describe('buttonSuffix()', () => {
  it('drops the leading slash and any origin, keeps the query', () => {
    expect(buttonSuffix('/agent/runs/abc')).toBe('agent/runs/abc');
    expect(buttonSuffix('https://mybrain.1site.ai/tasks?tab=review&rtab=daily')).toBe('tasks?tab=review&rtab=daily');
    expect(buttonSuffix('')).toBe('');
  });
});

describe('ownerFirstName()', () => {
  it('reads owner.name (first word) from Settings, else the default — and survives a stub without settings', async () => {
    const withName: any = { setting: { findUnique: async ({ where }: any) => (where.key === 'owner.name' ? { value: 'Sandeep Karnati' } : null) } };
    expect(await ownerFirstName(withName)).toBe('Sandeep');
    const none: any = { setting: { findUnique: async () => null } };
    expect(await ownerFirstName(none)).toBe('Sandy');
    expect(await ownerFirstName({} as any)).toBe('Sandy');
    expect(await ownerFirstName(null)).toBe('Sandy');
  });
});

describe('templateUnusable()', () => {
  it("knows Postbox's 'not approved' and 'does not exist' wordings, and nothing else", () => {
    expect(templateUnusable("That message template isn't approved yet (or the language code is wrong).")).toBe(true);
    expect(templateUnusable('Template name does not exist in the translation')).toBe(true);
    expect(templateUnusable('Re-engagement message')).toBe(false);
    expect(templateUnusable("The template's fill-in values don't match — wrong number of variables.")).toBe(false);
    expect(templateUnusable(null)).toBe(false);
  });
});

describe('withoutLinks()', () => {
  it('drops URLs and the arrow/colon in front of them, and says whether there was one', () => {
    expect(withoutLinks('42 rows → https://docs.google.com/spreadsheets/d/abc')).toEqual({ text: '42 rows', hadLink: true });
    expect(withoutLinks('Sheet: https://x.y/z and more')).toEqual({ text: 'Sheet and more', hadLink: true });
    expect(withoutLinks('no link here')).toEqual({ text: 'no link here', hadLink: false });
  });
});

describe('sendOwnerAlert()', () => {
  it('sends the result template first — name + the one-line result — with the button suffix, no text', async () => {
    const b = box();
    const r = await sendOwnerAlert(b.postbox, '919999', { firstName: 'Sandy', headline: 'Agent finished', detail: '42 rows appended', path: '/agent/runs/r1' });
    expect(r).toEqual({ sent: true, via: 'template', wamid: 'wamid.T', template: OWNER_RESULT_TEMPLATE });
    expect(b.calls).toEqual([{ kind: 'template', to: '919999', name: OWNER_RESULT_TEMPLATE, variables: ['Sandy', 'Agent finished · 42 rows appended'], buttonUrl: 'agent/runs/r1' }]);
  });

  it('result template not approved yet → falls through to the original update template with its three variables (BEA-1379)', async () => {
    const b = box({ templateByName: { [OWNER_RESULT_TEMPLATE]: { status: 'failed', error: "That message template isn't approved yet" } } });
    const r = await sendOwnerAlert(b.postbox, '919999', { firstName: 'Sandy', headline: 'Agent finished', detail: '42 rows appended', path: '/agent/runs/r1' });
    expect(r.sent).toBe(true);
    expect(r.via).toBe('template');
    expect(r.template).toBe(OWNER_TEMPLATE);
    expect(b.calls.map((c) => c.name)).toEqual([OWNER_RESULT_TEMPLATE, OWNER_TEMPLATE]);
    expect(b.calls[1].variables).toEqual(['Sandy', 'Agent finished', '42 rows appended']);
  });

  it('keeps links OUT of the variables — Meta refused the one live send that carried a sheet URL', async () => {
    const b = box();
    await sendOwnerAlert(b.postbox, '9', { headline: 'Agent finished', detail: '1 row → https://docs.google.com/spreadsheets/d/1Q_abc', path: '/agent/runs/r1' });
    const [, result] = b.calls[0].variables;
    expect(result).not.toMatch(/https?:/);
    expect(result).toBe('Agent finished · 1 row · The link is behind the button below.');
    expect(b.calls[0].buttonUrl).toBe('agent/runs/r1'); // the run page has the sheet link
  });

  it('fills the blanks so Meta never sees an empty variable', async () => {
    const b = box();
    await sendOwnerAlert(b.postbox, '9', { headline: '', path: '' });
    expect(b.calls[0].variables).toEqual(['Sandy', 'An update is ready. · Open My Brain for the details.']);
    expect(b.calls[0].buttonUrl).toBeUndefined();
  });

  it('a long body follows the template as a SECOND message; a short one does not', async () => {
    const long = box();
    const body = 'line\n'.repeat(300);
    const r = await sendOwnerAlert(long.postbox, '9', { headline: 'h', detail: body, path: '/lab', longBody: body });
    expect(r.sent).toBe(true);
    expect(r.followUp).toBe('sent');
    expect(long.calls.map((c) => c.kind)).toEqual(['template', 'text']);
    expect(long.calls[1].body.length).toBeLessThanOrEqual(3900);

    const short = box();
    await sendOwnerAlert(short.postbox, '9', { headline: 'h', detail: 'short', path: '/lab', longBody: 'short' });
    expect(short.calls.map((c) => c.kind)).toEqual(['template']);
  });

  it("Meta refuses the template → sent:false with Meta's reason, and no free text is tried", async () => {
    const b = box({ template: { status: 'failed', error: 'Re-engagement message' } });
    const r = await sendOwnerAlert(b.postbox, '9', { headline: 'h', path: '/p' });
    expect(r.sent).toBe(false);
    expect(r.error).toBe('Re-engagement message');
    expect(b.calls.map((c) => c.kind)).toEqual(['template']);
  });

  it('BOTH templates not approved → free text AND the caveat, after trying each name once', async () => {
    const b = box({ template: { status: 'failed', error: "That message template isn't approved yet" } });
    const r = await sendOwnerAlert(b.postbox, '9', { headline: 'Agent finished', detail: 'the sheet', path: '/agent/runs/r1' });
    expect(r.sent).toBe(true);
    expect(r.via).toBe('text');
    expect(r.note).toBe(NOT_APPROVED_NOTE);
    expect(b.calls.map((c) => c.kind)).toEqual(['template', 'template', 'text']);
    expect(b.calls.map((c) => c.name)).toEqual([OWNER_RESULT_TEMPLATE, OWNER_TEMPLATE, undefined]);
    expect(b.calls[2].body).toBe('🤖 Agent finished\nthe sheet\n\nOpen: https://mybrain.1site.ai/agent/runs/r1');
  });

  it('template not approved AND the text refused → not sent, both reasons kept', async () => {
    const b = box({ template: { status: 'failed', error: 'not approved' }, text: { status: 'failed', error: 'window closed' } });
    const r = await sendOwnerAlert(b.postbox, '9', { headline: 'h', path: '/p' });
    expect(r.sent).toBe(false);
    expect(r.error).toBe('window closed');
    expect(r.note).toBe(NOT_APPROVED_NOTE);
  });

  it('Postbox not configured → nothing is attempted', async () => {
    const b = box({ configured: false });
    const r = await sendOwnerAlert(b.postbox, '9', { headline: 'h', path: '/p' });
    expect(r.sent).toBe(false);
    expect(b.calls).toHaveLength(0);
  });
});

/** BEA-1379 — Meta's real verdict is checked after the accept; refused → the same alert on Telegram. */
describe("sendOwnerAlert() — Meta's real verdict", () => {
  const REFUSAL = 'This message was not delivered to maintain healthy ecosystem engagement';
  const msg = { headline: 'Agent finished', detail: '42 rows', path: '/agent/runs/r1' };

  function telegramBox(ok = true) {
    const pushes: any[] = [];
    return { pushes, telegram: { notifyWhatsAppRefused: async (a: any) => { pushes.push(a); return ok ? { sent: true } : { sent: false, why: 'no Telegram chat is linked in Settings' }; } } };
  }

  it('refused after the accept → the SAME alert goes out on Telegram, said honestly', async () => {
    const b = box({ template: { status: 'sent', wamid: 'wamid.T', id: 'm1' }, statuses: [{ status: 'failed', error: REFUSAL }] });
    const tg = telegramBox();
    const r = await sendOwnerAlert(b.postbox, '9', msg, { telegram: tg.telegram });
    expect(r.sent).toBe(true);
    expect(r.via).toBe('telegram');
    expect(r.delivery).toBe('refused');
    expect(r.error).toBe(REFUSAL);
    expect(tg.pushes).toHaveLength(1);
    expect(tg.pushes[0].headline).toBe('Agent finished');
    expect(tg.pushes[0].url).toBe('https://mybrain.1site.ai/agent/runs/r1');
    expect(whatsappStepLabel(r)).toEqual({ label: 'WhatsApp refused by Meta (engagement pacing) — sent on Telegram instead.', status: 'done' });
    expect(whatsappStepLabel(r).label).toBe(REFUSED_ON_TELEGRAM);
  });

  it('delivered → nothing extra is sent, plain "WhatsApp sent (template)"', async () => {
    const b = box({ template: { status: 'sent', wamid: 'wamid.T', id: 'm1' }, statuses: [{ status: 'delivered' }] });
    const tg = telegramBox();
    const r = await sendOwnerAlert(b.postbox, '9', msg, { telegram: tg.telegram });
    expect(r).toMatchObject({ sent: true, via: 'template', delivery: 'delivered' });
    expect(tg.pushes).toHaveLength(0);
    expect(whatsappStepLabel(r).label).toBe('WhatsApp sent (template)');
  });

  it('status route unreachable → sent, but the step SAYS delivery unconfirmed', async () => {
    const b = box({ template: { status: 'sent', wamid: 'wamid.T', id: 'm1' }, statuses: [null] });
    const tg = telegramBox();
    const r = await sendOwnerAlert(b.postbox, '9', msg, { telegram: tg.telegram });
    expect(r).toMatchObject({ sent: true, via: 'template', delivery: 'unconfirmed' });
    expect(tg.pushes).toHaveLength(0);
    expect(whatsappStepLabel(r).label).toBe('WhatsApp sent (template) — delivery unconfirmed');
  });

  it('still `sent` at the first look → ONE retry; refused on the second → Telegram', async () => {
    const b = box({ template: { status: 'sent', wamid: 'wamid.T', id: 'm1' }, statuses: [{ status: 'sent' }, { status: 'failed', error: REFUSAL }] });
    const tg = telegramBox();
    const r = await sendOwnerAlert(b.postbox, '9', msg, { telegram: tg.telegram });
    expect(b.statusCalls).toEqual(['m1', 'm1']);
    expect(r.via).toBe('telegram');
    expect(tg.pushes).toHaveLength(1);
  });

  it('still `sent` after the retry → no verdict claimed, plain "WhatsApp sent (template)", no Telegram', async () => {
    const b = box({ template: { status: 'sent', wamid: 'wamid.T', id: 'm1' }, statuses: [{ status: 'sent' }, { status: 'sent' }] });
    const tg = telegramBox();
    const r = await sendOwnerAlert(b.postbox, '9', msg, { telegram: tg.telegram });
    expect(b.statusCalls).toHaveLength(2); // exactly one retry — the constants live in VERDICT
    expect(r).toMatchObject({ sent: true, via: 'template' });
    expect(r.delivery).toBeUndefined();
    expect(tg.pushes).toHaveLength(0);
    expect(whatsappStepLabel(r).label).toBe('WhatsApp sent (template)');
  });

  it('NO double-Telegram: when the caller already pushed this alert on Telegram, a refusal only says so', async () => {
    const b = box({ template: { status: 'sent', wamid: 'wamid.T', id: 'm1' }, statuses: [{ status: 'failed', error: REFUSAL }] });
    const tg = telegramBox();
    setOwnerAlertTelegram(tg.telegram); // even a registered default must not fire
    const r = await sendOwnerAlert(b.postbox, '9', msg, { telegramCarried: true });
    expect(r.sent).toBe(false);
    expect(r.telegram).toBe('already');
    expect(tg.pushes).toHaveLength(0);
    expect(whatsappStepLabel(r).label).toBe('⚠️ WhatsApp refused by Meta (engagement pacing) — this alert already went out on Telegram');
  });

  it('refused and Telegram cannot carry it → sent:false and the step says both, plainly', async () => {
    const b = box({ template: { status: 'sent', wamid: 'wamid.T', id: 'm1' }, statuses: [{ status: 'failed', error: REFUSAL }] });
    const tg = telegramBox(false);
    const r = await sendOwnerAlert(b.postbox, '9', msg, { telegram: tg.telegram });
    expect(r.sent).toBe(false);
    expect(r.telegram).toBe('failed');
    expect(whatsappStepLabel(r).label).toBe('⚠️ WhatsApp refused by Meta (engagement pacing) — and Telegram could not carry it (no Telegram chat is linked in Settings)');
  });

  it('the Telegram road registered at boot (setOwnerAlertTelegram) is the default', async () => {
    const b = box({ template: { status: 'sent', wamid: 'wamid.T', id: 'm1' }, statuses: [{ status: 'failed', error: REFUSAL }] });
    const tg = telegramBox();
    setOwnerAlertTelegram(tg.telegram);
    const r = await sendOwnerAlert(b.postbox, '9', msg); // no opts at all — every existing caller
    expect(r.via).toBe('telegram');
    expect(tg.pushes).toHaveLength(1);
  });

  it('an old stub with no messageStatus never polls and behaves exactly as before', async () => {
    const b = box({ template: { status: 'sent', wamid: 'wamid.T' } }); // no statuses → no messageStatus on the stub
    const r = await sendOwnerAlert(b.postbox, '9', msg);
    expect(r).toEqual({ sent: true, via: 'template', wamid: 'wamid.T', template: OWNER_RESULT_TEMPLATE });
  });
});

describe('whatsappStepLabel() — the honest step line', () => {
  it('says how it went out, and never "accepted for delivery"', () => {
    expect(whatsappStepLabel({ sent: true, via: 'template' })).toEqual({ label: 'WhatsApp sent (template)', status: 'done' });
    expect(whatsappStepLabel({ sent: true, via: 'text', note: NOT_APPROVED_NOTE }).label).toBe(`WhatsApp sent (free text) — ${NOT_APPROVED_NOTE}`);
    expect(whatsappStepLabel({ sent: false, error: 'Re-engagement message' })).toEqual({ label: '⚠️ WhatsApp failed: Re-engagement message', status: 'info' });
    expect(whatsappStepLabel({ sent: false, why: 'no number' }).label).toMatch(/no WhatsApp number in Settings/);
    expect(whatsappStepLabel({ sent: false, why: 'off' }).label).toMatch(/switch is off/);
    expect(whatsappStepLabel({ sent: false, why: 'postbox not configured' }).label).toMatch(/not set up on this server/);
    expect(whatsappStepLabel(null).label).toMatch(/not available on this server/);
    for (const r of [{ sent: true, via: 'template' as const }, { sent: false, error: 'x' }]) expect(whatsappStepLabel(r).label).not.toMatch(/accepted for delivery/);
  });
});
