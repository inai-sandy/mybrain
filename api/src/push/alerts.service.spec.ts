import { AlertsService } from './alerts.service';

function harness(opts: { enabled?: string; to?: string; textFails?: boolean; configured?: boolean } = {}) {
  const settings = new Map<string, string>();
  if (opts.enabled !== undefined) settings.set('alerts.onFailure', opts.enabled);
  if (opts.to !== undefined) settings.set('alerts.whatsappNumber', opts.to);
  const prisma: any = { setting: { findUnique: async ({ where }: any) => (settings.has(where.key) ? { value: settings.get(where.key) } : null) } };
  const sent: any[] = [];
  const postbox: any = {
    isConfigured: () => opts.configured !== false,
    sendText: jest.fn(async (to: string, body: string) => { if (opts.textFails) return { status: 'failed', error: 'outside session window' }; sent.push({ kind: 'text', to, body }); return { status: 'sent' }; }),
    sendReminderTemplate: jest.fn(async (to: string, name: string, subject: string) => { sent.push({ kind: 'template', to, subject }); return { status: 'sent' }; }),
  };
  return { svc: new AlertsService(prisma, postbox), sent, postbox };
}

describe('AlertsService — WhatsApp me when an automation fails (BEA-1071)', () => {
  it('sends one plain message with name + reason + link', async () => {
    const h = harness({ to: '9198xxxx' });
    const r = await h.svc.runFailed('Morning Brief', 'Engine unreachable', '/agent/runs/r1');
    expect(r.sent).toBe(true);
    expect(h.sent[0].kind).toBe('text');
    expect(h.sent[0].body).toContain('Morning Brief failed');
    expect(h.sent[0].body).toContain('Engine unreachable');
    expect(h.sent[0].body).toContain('https://mybrain.1site.ai/agent/runs/r1');
  });

  it('falls back to the approved template when plain text cannot deliver', async () => {
    const h = harness({ to: '9198xxxx', textFails: true });
    const r = await h.svc.runFailed('Morning Brief', 'boom', '/agent/runs/r1');
    expect(r.sent).toBe(true);
    expect(h.sent[0].kind).toBe('template');
  });

  it('stays silent when off, when no number is set, or during the per-name cooldown', async () => {
    expect((await harness({ to: '91', enabled: 'false' }).svc.runFailed('X', 'e', '/p')).why).toBe('off');
    expect((await harness({}).svc.runFailed('X', 'e', '/p')).why).toBe('no number');
    const h = harness({ to: '9198xxxx' });
    expect((await h.svc.runFailed('X', 'e', '/p')).sent).toBe(true);
    expect((await h.svc.runFailed('X', 'e again', '/p')).why).toBe('cooldown'); // same name, 30-min window
    expect((await h.svc.runFailed('Y', 'e', '/p')).sent).toBe(true); // a different automation still alerts
  });
});
