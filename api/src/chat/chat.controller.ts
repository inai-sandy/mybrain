import { BadRequestException, Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('sessions')
  async list() {
    return { sessions: await this.chat.listSessions() };
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
}
