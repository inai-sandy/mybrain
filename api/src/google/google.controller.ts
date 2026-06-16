import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { GoogleService } from './google.service';
import { GmailBriefService } from './gmail-brief.service';
import { GmailRequestService } from './gmail-request.service';
import { Public } from '../auth/public.decorator';

/** Map internal gws errors to friendly HTTP errors. */
function mapErr(e: any): never {
  const m = String(e?.message || e);
  if (m === 'not-connected') throw new BadRequestException('Google isn’t connected yet — run `gws auth` on your server (Settings → Integrations → Google).');
  if (m === 'bridge-down') throw new ServiceUnavailableException('The Google CLI bridge on your server isn’t reachable right now.');
  throw new BadRequestException(m);
}

@Controller('google')
export class GoogleController {
  constructor(
    private readonly google: GoogleService,
    private readonly brief: GmailBriefService,
    private readonly requests: GmailRequestService,
  ) {}

  // ---- Gmail Requests (public shared read first so it isn't shadowed) ----
  @Public()
  @Get('gmail/requests/shared/:shareId')
  async requestShared(@Param('shareId') shareId: string) {
    const doc = await this.requests.getShared(shareId);
    if (!doc) throw new NotFoundException('This link is not shared (or no longer shared).');
    return doc;
  }

  @Post('gmail/requests/search')
  async requestSearch(@Body() body: { query?: string }) {
    try {
      return await this.requests.search(body?.query || '');
    } catch (e) {
      mapErr(e);
    }
  }

  @Post('gmail/requests')
  async requestCreate(@Body() body: { query?: string; threadId?: string; title?: string }) {
    try {
      if (!body?.threadId) throw new BadRequestException('Pick an email thread first.');
      return await this.requests.create(body.query || '', body.threadId, body.title);
    } catch (e) {
      mapErr(e);
    }
  }

  @Get('gmail/requests')
  async requestList() {
    return this.requests.list();
  }

  @Get('gmail/requests/:id')
  async requestGet(@Param('id') id: string) {
    const r = await this.requests.get(id);
    if (!r) throw new NotFoundException('Request not found.');
    return r;
  }

  @Post('gmail/requests/:id/refresh')
  async requestRefresh(@Param('id') id: string) {
    try {
      const r = await this.requests.refresh(id);
      if (!r) throw new NotFoundException('Request not found.');
      return r;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      mapErr(e);
    }
  }

  @Patch('gmail/requests/:id')
  async requestRename(@Param('id') id: string, @Body() body: { title?: string }) {
    const r = await this.requests.rename(id, body?.title || '');
    if (!r) throw new NotFoundException('Request not found.');
    return r;
  }

  @Delete('gmail/requests/:id')
  async requestDelete(@Param('id') id: string) {
    return this.requests.remove(id);
  }

  @Post('gmail/requests/:id/share')
  async requestShare(@Param('id') id: string, @Body() body: { shared?: boolean }) {
    const r = await this.requests.setShared(id, body?.shared !== false);
    if (!r) throw new NotFoundException('Request not found.');
    return r;
  }

  @Post('gmail/requests/:id/memory')
  async requestMemory(@Param('id') id: string) {
    const r = await this.requests.saveMemory(id);
    if (!r) throw new NotFoundException('Request not found.');
    return r;
  }

  @Post('gmail/requests/:id/capture')
  async requestCapture(@Param('id') id: string) {
    try {
      const r = await this.requests.importCapture(id);
      if (!r) throw new NotFoundException('Request not found.');
      return r;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      mapErr(e);
    }
  }

  @Post('gmail/requests/:id/tasks')
  async requestTasks(@Param('id') id: string) {
    try {
      return await this.requests.toTasks(id);
    } catch (e) {
      mapErr(e);
    }
  }

  @Get('status')
  async status() {
    return this.google.status();
  }

  @Get('services')
  async services() {
    return this.google.services();
  }

  @Get('hints')
  async hints() {
    return this.google.hints();
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

  // ---- Gmail Daily Brief ----
  @Get('gmail/brief')
  async gmailBrief(@Query('day') day?: string) {
    try {
      const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : await this.brief.today();
      return await this.brief.getForDay(d);
    } catch (e) {
      mapErr(e);
    }
  }

  @Post('gmail/brief/generate')
  async gmailBriefGenerate(@Body() body: { day?: string }) {
    try {
      const day = body?.day && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : await this.brief.today();
      return await this.brief.generate(day, true);
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

  // ---- Calendar + Tasks ----
  @Get('calendar')
  async calendar() {
    try {
      return { events: await this.google.calendar() };
    } catch (e) {
      mapErr(e);
    }
  }

  @Get('tasks')
  async tasks() {
    try {
      return { lists: await this.google.tasks() };
    } catch (e) {
      mapErr(e);
    }
  }

  @Post('tasks/:list/:task/complete')
  async taskComplete(@Param('list') list: string, @Param('task') task: string) {
    try {
      return await this.google.taskComplete(list, task);
    } catch (e) {
      mapErr(e);
    }
  }

  // ---- Meet + Sheets + Slides ----
  @Post('meet/create')
  async meetCreate() {
    try {
      return await this.google.meetCreate();
    } catch (e) {
      mapErr(e);
    }
  }

  @Post('sheets/create')
  async sheetCreate(@Body() body: { title?: string }) {
    try {
      return await this.google.sheetCreate(body?.title || 'Untitled');
    } catch (e) {
      mapErr(e);
    }
  }

  @Post('slides/create')
  async slidesCreate(@Body() body: { title?: string }) {
    try {
      return await this.google.slidesCreate(body?.title || 'Untitled');
    } catch (e) {
      mapErr(e);
    }
  }

  // ---- Forms + Chat + Contacts ----
  @Get('forms')
  async forms() {
    try {
      return { forms: await this.google.forms() };
    } catch (e) {
      mapErr(e);
    }
  }

  @Get('chat')
  async chat() {
    try {
      return await this.google.chatSpaces();
    } catch (e) {
      mapErr(e);
    }
  }

  @Get('contacts')
  async contacts() {
    try {
      return { contacts: await this.google.contacts() };
    } catch (e) {
      mapErr(e);
    }
  }
}
