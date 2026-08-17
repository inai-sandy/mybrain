import { gunzipSync } from 'zlib';
import { sendJson } from './send-json';
import { ToolCatalogController } from '../tools/tool-catalog.controller';

const fake = (accept?: string) => {
  const headers: any = {};
  return {
    req: { headers: accept ? { 'accept-encoding': accept } : {} },
    setHeader: (k: string, v: string) => { headers[k] = v; },
    send: (b: any) => { headers._body = b; },
    end: (b: any) => { headers._body = b; },
    headers,
  } as any;
};

/**
 * The tool catalog holds every action of every connected service now (BEA-1354, ~750KB plain), so
 * it — like the /tools browse list — compresses itself on the wire when the browser can take it.
 */
describe('sendJson', () => {
  it('gzips a big answer only when asked, and leaves a small one alone', () => {
    const big = { tools: Array.from({ length: 900 }, (_, i) => ({ id: `svc:github.a${i}`, name: `GitHub: Action ${i}`, description: 'x'.repeat(120) })) };
    const zipped = fake('gzip, deflate, br');
    sendJson(zipped, big);
    expect(zipped.headers['Content-Encoding']).toBe('gzip');
    expect(zipped.headers['Vary']).toBe('Accept-Encoding');
    expect(JSON.parse(gunzipSync(zipped.headers._body).toString('utf8')).tools).toHaveLength(900);
    expect(zipped.headers._body.length).toBeLessThan(JSON.stringify(big).length / 5);

    const plain = fake();
    sendJson(plain, big);
    expect(plain.headers['Content-Encoding']).toBeUndefined();
    expect(JSON.parse(plain.headers._body).tools).toHaveLength(900);

    const small = fake('gzip');
    sendJson(small, { ok: true });
    expect(small.headers['Content-Encoding']).toBeUndefined();
    expect(small.headers._body).toBe('{"ok":true}');
  });

  it('the catalog route answers through it', async () => {
    const big = { groups: [], tools: Array.from({ length: 900 }, (_, i) => ({ id: `svc:github.a${i}`, name: `GitHub: Action ${i}`, description: 'x'.repeat(120) })) };
    const c = new ToolCatalogController({ catalog: async () => big } as any);
    const res = fake('gzip');
    await c.list(res);
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(res.headers._body).toString('utf8')).tools).toHaveLength(900);
  });
});
