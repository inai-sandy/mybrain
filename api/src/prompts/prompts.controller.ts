import { BadRequestException, Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { PromptsService } from './prompts.service';

@Controller('prompts')
export class PromptsController {
  constructor(private readonly prompts: PromptsService) {}

  @Get()
  async list() {
    return { prompts: await this.prompts.list() };
  }

  @Put(':key')
  async set(@Param('key') key: string, @Body() body: { value?: string }) {
    const r = await this.prompts.set(key, body?.value || '');
    if (!r) throw new BadRequestException('Unknown prompt');
    return r;
  }

  @Post(':key/reset')
  async reset(@Param('key') key: string) {
    const r = await this.prompts.reset(key);
    if (!r) throw new BadRequestException('Unknown prompt');
    return r;
  }
}
