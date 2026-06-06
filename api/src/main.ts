import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import * as express from 'express';
import { existsSync } from 'fs';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');

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
