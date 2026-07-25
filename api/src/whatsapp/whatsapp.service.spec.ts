import { WhatsappService } from './whatsapp.service';

/** BEA-1114: My Brain's WhatsApp slice — used-templates only, app-scoped messages, honest failures. */
describe('WhatsappService', () => {
  const savedFetch = global.fetch;
  const savedEnv = { ...process.env };
  afterEach(() => { (global as any).fetch = savedFetch; process.env = { ...savedEnv }; });

  function mock(routes: Record<string, any>) {
    (global as any).fetch = jest.fn(async (url: string) => {
      const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
      if (!hit) return { ok: false, status: 404, json: async () => ({}) } as any;
      return { ok: true, json: async () => hit[1] } as any;
    });
  }

  it('templates: only the used ones, with category-flip and missing warnings', async () => {
    process.env.POSTBOX_ADMIN_TOKEN = 't';
    mock({ '/admin/templates': { templates: [
      { name: 'reminder_nudge_v3', language: 'en', status: 'APPROVED', category: 'MARKETING' },
      { name: 'rfq_requirement', language: 'en', status: 'APPROVED', category: 'UTILITY' }, // another app's — excluded
    ] } });
    const out = await new WhatsappService().templates();
    expect(out.configured).toBe(true);
    expect(out.templates.map((t: any) => t.name)).toEqual(['reminder_nudge_v3', 'task_list_v1']);
    expect(out.templates[0].warning).toContain('MARKETING'); // the flip is called out
    expect(out.templates[1].status).toBe('NOT_FOUND'); // missing shown honestly
  });

  it('messages: scoped to the My Brain app id, passthrough filters', async () => {
    process.env.POSTBOX_ADMIN_TOKEN = 't';
    const calls: string[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('/admin/apps')) return { ok: true, json: async () => [{ id: 'k1', name: 'KIOT Vendors' }, { id: 'mb1', name: 'My Brain' }] } as any;
      return { ok: true, json: async () => ({ rows: [{ id: 'm1', to: '919', type: 'text', body: 'hi', status: 'read', direction: 'out', createdAt: 'now' }], total: 1 }) } as any;
    });
    const out = await new WhatsappService().messages({ query: 'jayanth', status: 'read', page: 2 });
    expect(out.total).toBe(1);
    expect(out.rows[0].status).toBe('read');
    const msgUrl = calls.find((c) => c.includes('/admin/messages'))!;
    expect(msgUrl).toContain('appId=mb1'); // never other apps' traffic
    expect(msgUrl).toContain('query=jayanth');
    expect(msgUrl).toContain('page=2');
  });

  it('unconfigured stays quiet and honest', async () => {
    delete process.env.POSTBOX_ADMIN_TOKEN;
    const out = await new WhatsappService().templates();
    expect(out).toEqual({ configured: false, templates: [] });
  });
});
