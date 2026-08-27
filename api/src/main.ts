import 'reflect-metadata';
import { setDefaultAutoSelectFamily } from 'net';

/**
 * IPv6 TO AWS BLACKHOLES ON THIS BOX — TURN OFF HAPPY EYEBALLS (BEA-1511).
 *
 * His ESP32 agent died on `Reddit could not do that: fetch failed (ETIMEDOUT)`, and every retry died
 * the same way. Measured from inside the container:
 *
 *   forced IPv4  -> HTTP 404 in 959ms   (reaches it)
 *   by IP + SNI  -> HTTP 403 in 851ms   (reaches it)
 *   default      -> ETIMEDOUT in 528ms  (does not)
 *
 * Raw TCP to the same addresses connects in ~290ms, so it is not routing and it is not the vendor.
 * ScrapeCreators is AWS us-west-2 and dual-stack; IPv6 egress from this container goes nowhere.
 *
 * `NODE_OPTIONS=--dns-result-order=ipv4first` was already set and is NOT enough: since Node 20,
 * `autoSelectFamily` (Happy Eyeballs) is on by default and races BOTH families whatever order the
 * lookup returned, giving up after two 250ms attempts — which is exactly the 528ms seen above.
 *
 * Set here rather than in the deploy environment on purpose: an env var is one edit away from being
 * lost, and losing it costs a silent outage of every agent that talks to a dual-stack vendor. GitHub
 * and Google were unaffected throughout, which is what made this look like a vendor problem.
 */
setDefaultAutoSelectFamily(false);

import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { BODY_LIMIT } from './common/body-limit';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import * as express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync, readFileSync } from 'fs';
import { AppModule } from './app.module';
import { OAuthService } from './oauth/oauth.service';
import { DocumentsService } from './documents/documents.service';
import { PrismaService } from './prisma/prisma.service';
import { registerLinkPreviews } from './og/link-previews';
import { NewsPublicService } from './news/news-public.service';
import { RadarFeedService } from './news/radar-feed.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // How big a request body may be.
  //
  // Express defaults to 100 KB, which was never noticed because everything that had crossed this
  // line until now was small — Instagram posts, a table of rows, a plan. The first agent that
  // summarises EMAIL died on it: nine real messages with their bodies is comfortably past 100 KB,
  // and the run failed with "request entity too large" after a clean fetch, having written nothing.
  //
  // This is a single-user app and the worker road's traffic never leaves the machine (the host
  // runner talks to this container over the Docker gateway), so the limit is here to stop something
  // running away, not to police a stranger. `BODY_LIMIT` is the one place it is written.
  app.use(json({ limit: BODY_LIMIT }));
  app.use(urlencoded({ limit: BODY_LIMIT, extended: true }));
  app.use(cookieParser());
  app.setGlobalPrefix('api');

  // OAuth discovery MUST live at the domain root (not under /api) so MCP clients can find it.
  // Registered before the SPA fallback so they aren't shadowed by index.html. (BEA-758)
  const oauth = app.get(OAuthService);
  const server = app.getHttpAdapter().getInstance();
  server.get('/.well-known/oauth-authorization-server', (req: express.Request, res: express.Response) => res.json(oauth.authServerMetadata(oauth.origin(req))));
  server.get('/.well-known/oauth-protected-resource', (req: express.Request, res: express.Response) => res.json(oauth.protectedResourceMetadata(oauth.origin(req))));

  // Serve the built React app (copied to ../public in the Docker image).
  const pub = join(__dirname, '..', 'public');
  if (existsSync(pub)) {
    // A shared document link (/d/:slug) is served as the SPA shell WITH link-preview tags injected,
    // so WhatsApp/social show a real card while humans still get the viewer. (BEA-900)
    const docs = app.get(DocumentsService);

    // Direct raw-markdown links so Claude/curl can read a shared doc without JS: any share
    // link + ".md". Registered BEFORE /d/:slug so the .md suffix isn't swallowed by it. (BEA-970)
    const sendRaw = async (slug: string | null | undefined, res: express.Response) => {
      const r = slug ? await docs.sharedRaw(slug) : null;
      if (!r) { res.status(404).type('text/plain; charset=utf-8').send('Not found or not shared.'); return; }
      res.setHeader('X-Robots-Tag', 'noindex');
      res.setHeader('Cache-Control', 'no-store');
      res.type('text/plain; charset=utf-8').send(r.content);
    };
    server.get('/d/:slug.md', async (req: express.Request, res: express.Response) => {
      try { await sendRaw(req.params.slug, res); } catch { res.status(404).type('text/plain').send('Not found.'); }
    });
    server.get('/s/:code.md', async (req: express.Request, res: express.Response) => {
      try { const d = await docs.resolveShortCode(req.params.code); await sendRaw(d?.slug, res); }
      catch { res.status(404).type('text/plain').send('Not found.'); }
    });

    // Every shared surface (documents, short links, skills, meetings, bookmarks) gets its own
    // link-preview card injected into the shell. Anything not registered falls through to the
    // default card that ships in index.html. (BEA-1133 / BEA-1134)
    registerLinkPreviews(server, {
      pub,
      deps: { docs, prisma: app.get(PrismaService), news: app.get(NewsPublicService), radar: app.get(RadarFeedService) },
      origin: (req) => oauth.origin(req as unknown as express.Request),
    });

    app.use(express.static(pub));
    // SPA fallback: anything that isn't an /api route returns index.html.
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(join(pub, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 8080;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`my-brain api listening on :${port}`);
}
bootstrap();
