import { BadRequestException, Body, Controller, Get, Param, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { GoogleService } from './google.service';

/** Map internal gws errors to friendly HTTP errors. */
function mapErr(e: any): never {
  const m = String(e?.message || e);
  if (m === 'not-connected') throw new BadRequestException('Google isn’t connected yet — run `gws auth` on your server (Settings → Integrations → Google).');
  if (m === 'bridge-down') throw new ServiceUnavailableException('The Google CLI bridge on your server isn’t reachable right now.');
  throw new BadRequestException(m);
}

@Controller('google')
export class GoogleController {
  constructor(private readonly google: GoogleService) {}

  @Get('status')
  async status() {
    return this.google.status();
  }

  @Get('services')
  async services() {
    return this.google.services();
  }

  // ---- Gmail ----
  @Get('gmail')
  async gmail(@Query('q') q?: string) {
    try {
      return { messages: await this.google.gmailList(q) };
    } catch (e) {
      mapErr(e);
    }
  }

  @Post('gmail/:id/import')
  async gmailImport(@Param('id') id: string) {
    try {
      return await this.google.gmailImport(id);
    } catch (e) {
      mapErr(e);
    }
  }

  // ---- Drive / Docs / Sheets ----
  @Get('drive')
  async drive(@Query('q') q?: string) {
    try {
      return { files: await this.google.driveList(q) };
    } catch (e) {
      mapErr(e);
    }
  }

  @Post('drive/:id/import')
  async driveImport(@Param('id') id: string) {
    try {
      return await this.google.driveImport(id);
    } catch (e) {
      mapErr(e);
    }
  }

  @Post('docs/create')
  async docCreate(@Body() body: { title?: string; content?: string }) {
    try {
      return await this.google.docCreate(body?.title || 'Untitled', body?.content || '');
    } catch (e) {
      mapErr(e);
    }
  }
}
