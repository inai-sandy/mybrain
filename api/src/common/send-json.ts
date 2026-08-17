import { Response } from 'express';
import { gzipSync } from 'zlib';

/**
 * Send one JSON answer, gzipped when it is worth it and the browser said it could.
 *
 * Nothing in front of this app compresses (no `compression` middleware, and Caddy is not encoding
 * either — checked on the live site), so the few endpoints that carry a big list compress
 * themselves: the `/tools` browse list (~520KB → ~90KB), and since BEA-1354 the tool catalog and
 * the Flows palette, which hold every action of every connected service (~750KB → ~100KB). One
 * helper, no new dependency and no global middleware that could interfere with the app's streaming
 * endpoints. Below a few KB the compressing costs more than the bytes it saves.
 */
export function sendJson(res: Response, body: any) {
  const json = JSON.stringify(body);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  const wanted = /\bgzip\b/i.test(String((res.req as any)?.headers?.['accept-encoding'] || ''));
  if (!wanted || json.length < 8192) { res.send(json); return; }
  const zipped = gzipSync(Buffer.from(json, 'utf8'), { level: 6 });
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Content-Length', String(zipped.length));
  res.end(zipped);
}
