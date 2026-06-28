import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { FlowsService } from './flows.service';

@Controller('flows')
export class FlowsController {
  constructor(private readonly flows: FlowsService) {}

  @Get()
  async list() {
    return { flows: await this.flows.list() };
  }

  // static routes before :id
  @Get('palette')
  palette() {
    return this.flows.palette();
  }

  @Post('decompose')
  async decompose(@Body() body: { question?: string }) {
    if (!body?.question?.trim()) throw new BadRequestException('Type a question first.');
    return { subquestions: await this.flows.decompose(body.question.trim()) };
  }

  @Post()
  create(@Body() body: { name?: string; question?: string; graph?: unknown }) {
    return this.flows.create(body || {});
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.flows.get(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; question?: string; graph?: unknown }) {
    return this.flows.update(id, body || {});
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.flows.remove(id);
  }
}
