import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('sessions')
  async list(@Query('q') q?: string) {
    return { sessions: q ? await this.chat.searchSessions(q) : await this.chat.listSessions() };
  }

  @Get('starred')
  async starred() {
    return { starred: await this.chat.listStarred() };
  }

  @Get('retention')
  async getRetention() {
    return this.chat.getRetention();
  }

  @Put('retention')
  async setRetention(@Body() body: { months?: number }) {
    return this.chat.setRetention(body?.months ?? 2);
  }

  @Post('sessions')
  async create(@Body() body: { scope?: string }) {
    return this.chat.createSession(body?.scope);
  }

  @Get('sessions/:id')
  async get(@Param('id') id: string) {
    const s = await this.chat.getSession(id);
    if (!s) throw new BadRequestException('Chat not found');
    return s;
  }

  @Delete('sessions/:id')
  async remove(@Param('id') id: string) {
    return this.chat.deleteSession(id);
  }

  @Post('sessions/:id/message')
  async message(@Param('id') id: string, @Body() body: { text?: string }) {
    if (!body?.text?.trim()) throw new BadRequestException('Type a message');
    const r = await this.chat.sendMessage(id, body.text);
    if (!r) throw new BadRequestException('Chat not found');
    return r;
  }

  @Post('sessions/:id/pin')
  async pin(@Param('id') id: string, @Body() body: { pinned?: boolean }) {
    return this.chat.setPinned(id, body?.pinned ?? true);
  }

  @Post('messages/:mid/star')
  async star(@Param('mid') mid: string, @Body() body: { on?: boolean }) {
    const r = await this.chat.setStar(mid, body?.on ?? true);
    if (!r) throw new BadRequestException('Message not found');
    return r;
  }
}
