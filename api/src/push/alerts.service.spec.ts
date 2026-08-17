import { AlertsService } from './alerts.service';
import { OWNER_TEMPLATE } from '../contacts/owner-alert';

/**
 * Every owner-bound WhatsApp goes out as the approved template FIRST (BEA-1362). Free text is
 * never the only message: Postbox says `sent` for a text before Meta fails it outside the
 * 24-hour window, so "text, then template if it failed" could never fire — 93 alerts in a row
 * were lost that way.
 */
type Opts = { settings?: Record<string, string>; configured?: boolean; templateStatus?: string; templateError?: string; textStatus?: string };

function harness(opts: Opts = {}) {
  const settings = new Map<string, string>(Object.entries(opts.settings || {}));
  const prisma: any = { setting: { findUnique: async ({ where }: any) => (settings.has(where.key) ? { value: settings.get(where.key) } : null) } };
  const sent: any[] = [];
  const postbox: any = {
    isConfigured: () => opts.configured !== false,
    sendTemplate: jest.fn(async (to: string, name: string, variables: string[], o: any) => {
      sent.push({ kind: 'template', to, name, variables, buttonUrl: o?.buttonUrl });
      return opts.templateStatus === 'failed'
        ? { wamid: null, status: 'failed', error: opts.templateError || 'Meta refused it' }
        : { wamid: 'wamid.T', status: 'sent', error: null };
    }),
    sendText: jest.fn(async (to: string, body: string) => {
      sent.push({ kind: 'text', to, body });
      return opts.textStatus === 'failed' ? { wamid: null, status: 'failed', error: 'outside session window' } : { wamid: 'wamid.X', status: 'sent', error: null };
    }),
    sendReminderTemplate: jest.fn(async () => ({ status: 'sent' })),
  };
  return { svc: new AlertsService(prisma, postbox), sent, postbox };
}
const NUM = { 'alerts.whatsappNumber': '919999' };

describe('AlertsService.runFinished — template first (BEA-1102 · BEA-1362)', () => {
  it('sends the approved template with name, headline and the run behind the button — no free text', async () => {
    const h = harness({ settings: NUM });
    const r = await h.svc.runFinished('Tech news', 'Apple on-device model + 3 more', '/agent/runs/r1');
    expect(r.sent).toBe(true);
    expect(r.via).toBe('template');
    expect(r.wamid).toBe('wamid.T');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].kind).toBe('template');
    expect(h.sent[0].name).toBe(OWNER_TEMPLATE);
    expect(h.sent[0].variables).toEqual(['Sandy', 'Tech news finished', 'Apple on-device model + 3 more']);
    expect(h.sent[0].buttonUrl).toBe('agent/runs/r1');
    expect(h.postbox.sendText).not.toHaveBeenCalled();
    expect(h.postbox.sendReminderTemplate).not.toHaveBeenCalled();
  });

  it('uses the owner\'s first name from Settings when one is saved', async () => {
    const h = harness({ settings: { ...NUM, 'owner.name': 'Sandeep Karnati' } });
    await h.svc.runFinished('X', 'y', '/p');
    expect(h.sent[0].variables[0]).toBe('Sandeep');
  });

  it('never puts a newline inside a template variable — Meta rejects them', async () => {
    const h = harness({ settings: NUM });
    await h.svc.runFinished('Watch\nlegrand', '42 rows\n→ https://sheet\n\nmore', '/agent/runs/r1');
    for (const v of h.sent[0].variables) expect(v).not.toMatch(/\n/);
    expect(h.sent[0].variables[2]).toBe('42 rows · more · The link is behind the button below.'); // links stay out of variables
  });

  it('a Watch/Alert that fired is worded as an alert', async () => {
    const h = harness({ settings: NUM });
    await h.svc.runFinished('🔔 legrand followers', '100 → 120', '/agent/runs/r1', { kind: 'alert' });
    expect(h.sent[0].variables[1]).toBe('🔔 legrand followers — alert');
  });

  it("Meta refuses the template → NOT sent, with Meta's reason, and no free text is tried", async () => {
    const h = harness({ settings: NUM, templateStatus: 'failed', templateError: 'Re-engagement message' });
    const r = await h.svc.runFinished('Tech news', 'headline', '/agent/runs/r1');
    expect(r.sent).toBe(false);
    expect(r.why).toBe('Re-engagement message');
    expect(r.error).toBe('Re-engagement message');
    expect(h.postbox.sendText).not.toHaveBeenCalled();
  });

  it('template not approved yet → falls back to free text AND says it may not deliver', async () => {
    const h = harness({ settings: NUM, templateStatus: 'failed', templateError: "That message template isn't approved yet (or the language code is wrong)." });
    const r = await h.svc.runFinished('Tech news', 'headline', '/agent/runs/r1');
    expect(r.sent).toBe(true);
    expect(r.via).toBe('text');
    expect(r.note).toBe('template not approved yet — free text may not deliver outside 24h');
    expect(h.sent.map((s) => s.kind)).toEqual(['template', 'text']);
    expect(h.sent[1].body).toContain('Tech news finished');
    expect(h.sent[1].body).toContain('https://mybrain.1site.ai/agent/runs/r1');
  });

  it('the old road is gone: a free text that Postbox "accepts" can no longer count as sent', async () => {
    // Postbox answers `sent` to any text; only the template's verdict is trusted.
    const h = harness({ settings: NUM, templateStatus: 'failed', templateError: 'Meta refused it', textStatus: 'sent' });
    const r = await h.svc.runFinished('X', 'y', '/p');
    expect(r.sent).toBe(false);
    expect(h.postbox.sendText).not.toHaveBeenCalled();
  });

  it('respects the master switch, a missing number and an unconfigured Postbox — unchanged', async () => {
    expect((await harness({ settings: { 'whatsapp.outputs': 'false', ...NUM } }).svc.runFinished('X', 'y', '/p')).why).toBe('off');
    expect((await harness({}).svc.runFinished('X', 'y', '/p')).why).toBe('no number');
    const h = harness({ settings: NUM, configured: false });
    expect((await h.svc.runFinished('X', 'y', '/p')).why).toBe('postbox not configured');
    expect(h.sent).toHaveLength(0);
  });
});

describe('AlertsService.runFailed — WhatsApp me when an automation fails (BEA-1071 · BEA-1362)', () => {
  it('sends the template with name + reason + the run behind the button', async () => {
    const h = harness({ settings: NUM });
    const r = await h.svc.runFailed('Morning Brief', 'Engine unreachable', '/agent/runs/r1');
    expect(r.sent).toBe(true);
    expect(h.sent[0].kind).toBe('template');
    expect(h.sent[0].variables[1]).toBe('⚠️ Morning Brief failed');
    expect(h.sent[0].variables[2]).toBe('Engine unreachable');
    expect(h.sent[0].buttonUrl).toBe('agent/runs/r1');
    expect(h.postbox.sendText).not.toHaveBeenCalled();
  });

  it("says why when Meta refuses — never 'sent'", async () => {
    const h = harness({ settings: NUM, templateStatus: 'failed', templateError: 'boom from Meta' });
    const r = await h.svc.runFailed('Morning Brief', 'boom', '/agent/runs/r1');
    expect(r.sent).toBe(false);
    expect(r.why).toBe('boom from Meta');
  });

  it('stays silent when off, when no number is set, or during the per-name cooldown', async () => {
    expect((await harness({ settings: { 'alerts.onFailure': 'false', 'alerts.whatsappNumber': '91' } }).svc.runFailed('X', 'e', '/p')).why).toBe('off');
    expect((await harness({}).svc.runFailed('X', 'e', '/p')).why).toBe('no number');
    const h = harness({ settings: NUM });
    expect((await h.svc.runFailed('X', 'e', '/p')).sent).toBe(true);
    expect((await h.svc.runFailed('X', 'e again', '/p')).why).toBe('cooldown'); // same name, 30-min window
    expect((await h.svc.runFailed('Y', 'e', '/p')).sent).toBe(true); // a different automation still alerts
  });
});

describe('AlertsService.dailyMissDigest — the same road (BEA-1121 · BEA-1362)', () => {
  it('goes template first: one line per miss folded into the detail, the review tab behind the button', async () => {
    const h = harness({ settings: NUM });
    const r = await h.svc.dailyMissDigest('2026-08-17', [{ title: 'Production update', contact: 'Jayanth' }, { title: 'Sales report', contact: null }]);
    expect(r.sent).toBe(true);
    expect(h.sent[0].kind).toBe('template');
    expect(h.sent[0].variables[1]).toBe('📋 2026-08-17: 2 daily updates did not come in');
    expect(h.sent[0].variables[2]).toBe('• Production update — Jayanth · • Sales report');
    expect(h.sent[0].buttonUrl).toBe('tasks?tab=review&rtab=daily');
  });

  it('nothing missed → nothing sent; no number → unchanged', async () => {
    expect((await harness({ settings: NUM }).svc.dailyMissDigest('d', [])).why).toBe('nothing missed');
    expect((await harness({}).svc.dailyMissDigest('d', [{ title: 'x', contact: null }])).why).toBe('no number');
  });
});

describe('AlertsService.labWeekly — the same road (BEA-1144 · BEA-1362)', () => {
  it('a short line rides in the template alone; a long one is followed by the full text', async () => {
    const short = harness({ settings: NUM });
    expect((await short.svc.labWeekly('You slept better on days you walked.', 'what the Lab noticed this week')).sent).toBe(true);
    expect(short.sent.map((s) => s.kind)).toEqual(['template']);

    const long = harness({ settings: NUM });
    const body = 'A long note.\n'.repeat(80);
    const r = await long.svc.labWeekly(body, 'what the Lab noticed this week');
    expect(r.sent).toBe(true);
    expect(r.followUp).toBe('sent');
    expect(long.sent.map((s) => s.kind)).toEqual(['template', 'text']); // template FIRST, text after
    expect(long.sent[0].buttonUrl).toBe('lab');
  });
});
