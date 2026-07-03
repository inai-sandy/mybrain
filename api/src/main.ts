import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import * as express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'fs';
import { AppModule } from './app.module';
import { OAuthService } from './oauth/oauth.service';

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
