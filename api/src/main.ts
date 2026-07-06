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

/** Open Graph + Twitter tags for a shared document's link preview (BEA-900). */
function ogTags(m: { title: string; description: string; image: string; url: string }): string {
  const e = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  return [
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="My Brain">`,
    `<meta property="og:title" content="${e(m.title)}">`,
    `<meta property="og:description" content="${e(m.description)}">`,
    `<meta property="og:url" content="${e(m.url)}">`,
    `<meta property="og:image" content="${e(m.image)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(m.title)}">`,
    `<meta name="twitter:description" content="${e(m.description)}">`,
    `<meta name="twitter:image" content="${e(m.image)}">`,
  ].join('');
}

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
    server.get('/d/:slug', async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const meta = await docs.ogMeta(req.params.slug, oauth.origin(req));
        if (!meta) return next();
        const html = readFileSync(join(pub, 'index.html'), 'utf8');
        const withTags = html
          .replace(/<title>[\s\S]*?<\/title>/i, `<title>${meta.title.replace(/</g, '&lt;')}</title>`)
          .replace('</head>', ogTags(meta) + '</head>');
        res.type('html').send(withTags);
      } catch { next(); }
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
