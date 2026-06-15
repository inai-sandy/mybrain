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
}
