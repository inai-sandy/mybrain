import { GeminiService } from './gemini.service';

describe('GeminiService.status', () => {
  const realFetch = global.fetch;
  afterEach(() => { (global as any).fetch = realFetch; });

  it('maps a connected runner status through', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ installed: true, version: '1.0.9', loggedIn: false, ready: false, workdir: '/home/sandy/brain-agent' }) });
    const s = await new GeminiService().status();
    expect(s).toMatchObject({ connected: true, installed: true, version: '1.0.9', loggedIn: false, ready: false });
  });

  it('reports offline (not a crash) when the runner is unreachable', async () => {
    (global as any).fetch = async () => { throw new Error('ECONNREFUSED'); };
    const s = await new GeminiService().status();
    expect(s).toMatchObject({ connected: false, installed: false, ready: false });
    expect((s as any).reason).toBe('runner unreachable');
  });
});
