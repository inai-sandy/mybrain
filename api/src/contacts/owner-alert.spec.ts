import { buttonSuffix, flat, NOT_APPROVED_NOTE, OWNER_TEMPLATE, ownerFirstName, sendOwnerAlert, templateUnusable, whatsappStepLabel, withoutLinks } from './owner-alert';

/** BEA-1362 — the one road to the owner's phone: template first, free text never alone. */
function box(opts: { template?: { status: string; error?: string; wamid?: string }; text?: { status: string; error?: string }; configured?: boolean } = {}) {
  const calls: any[] = [];
  return {
    calls,
    postbox: {
      isConfigured: () => opts.configured !== false,
      sendTemplate: async (to: string, name: string, variables: string[], o: any) => { calls.push({ kind: 'template', to, name, variables, buttonUrl: o?.buttonUrl }); return opts.template || { status: 'sent', wamid: 'wamid.T' }; },
      sendText: async (to: string, body: string) => { calls.push({ kind: 'text', to, body }); return opts.text || { status: 'sent', wamid: 'wamid.X' }; },
    },
  };
}

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
  it('sends the approved template first with the three variables and the button suffix — no text', async () => {
    const b = box();
    const r = await sendOwnerAlert(b.postbox, '919999', { firstName: 'Sandy', headline: 'Agent finished', detail: '42 rows appended', path: '/agent/runs/r1' });
    expect(r).toEqual({ sent: true, via: 'template', wamid: 'wamid.T' });
    expect(b.calls).toEqual([{ kind: 'template', to: '919999', name: OWNER_TEMPLATE, variables: ['Sandy', 'Agent finished', '42 rows appended'], buttonUrl: 'agent/runs/r1' }]);
  });

  it('keeps links OUT of the variables — Meta refused the one live send that carried a sheet URL', async () => {
    const b = box();
    await sendOwnerAlert(b.postbox, '9', { headline: 'Agent finished', detail: '1 row → https://docs.google.com/spreadsheets/d/1Q_abc', path: '/agent/runs/r1' });
    const [, headline, detail] = b.calls[0].variables;
    expect(headline).not.toMatch(/https?:/);
    expect(detail).not.toMatch(/https?:/);
    expect(detail).toBe('1 row · The link is behind the button below.');
    expect(b.calls[0].buttonUrl).toBe('agent/runs/r1'); // the run page has the sheet link
  });

  it('fills the blanks so Meta never sees an empty variable', async () => {
    const b = box();
    await sendOwnerAlert(b.postbox, '9', { headline: '', path: '' });
    expect(b.calls[0].variables).toEqual(['Sandy', 'An update is ready.', 'Open My Brain for the details.']);
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

  it('template not approved → free text AND the caveat', async () => {
    const b = box({ template: { status: 'failed', error: "That message template isn't approved yet" } });
    const r = await sendOwnerAlert(b.postbox, '9', { headline: 'Agent finished', detail: 'the sheet', path: '/agent/runs/r1' });
    expect(r.sent).toBe(true);
    expect(r.via).toBe('text');
    expect(r.note).toBe(NOT_APPROVED_NOTE);
    expect(b.calls[1].body).toBe('🤖 Agent finished\nthe sheet\n\nOpen: https://mybrain.1site.ai/agent/runs/r1');
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
