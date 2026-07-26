import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
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

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
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
      deps: { docs, prisma: app.get(PrismaService) },
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
