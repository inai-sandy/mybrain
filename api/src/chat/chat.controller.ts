import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
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

  @Get('model')
  async getModel() {
    return this.chat.getModel();
  }

  @Put('model')
  async setModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.chat.setModel(body.provider || 'openrouter', body.model);
  }

  @Get('models')
  async models() {
    return { models: await this.chat.listModels() };
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

  /** Get (or create) the chat bound to one document. */
  @Get('doc/:itemId')
  async doc(@Param('itemId') itemId: string) {
    const s = await this.chat.docSession(itemId);
    if (!s) throw new BadRequestException('Document not found');
    return s;
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

  @Post('sessions/:id/message/stream')
  async stream(@Param('id') id: string, @Body() body: { text?: string }, @Res() res: Response) {
    if (!body?.text?.trim()) {
      res.status(400).json({ message: 'Type a message' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    (res as any).flushHeaders?.();
    try {
      const r = await this.chat.streamMessage(id, body.text, (tok) => res.write(`data: ${JSON.stringify({ token: tok })}\n\n`));
      if (!r) res.write(`data: ${JSON.stringify({ error: 'Chat not found' })}\n\n`);
      else res.write(`data: ${JSON.stringify({ done: true, userMessage: r.userMessage, message: r.message })}\n\n`);
    } catch (e: any) {
      res.write(`data: ${JSON.stringify({ error: e?.message || 'failed' })}\n\n`);
    }
    res.end();
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
