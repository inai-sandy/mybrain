import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { SkillsService } from './skills.service';

@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Post()
  async create(@Body() body: { title?: string; description?: string; content?: string; origin?: string; platform?: string; downloadUrl?: string }) {
    if (!body?.title?.trim() && !body?.content?.trim()) throw new BadRequestException('Add a title or paste the skill content');
    return this.skills.create(body || {});
  }

  @Get()
  async list() {
    return { skills: await this.skills.list() };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const s = await this.skills.get(id);
    if (!s) throw new BadRequestException('Skill not found');
    return s;
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    const s = await this.skills.update(id, body || {});
    if (!s) throw new BadRequestException('Skill not found');
    return s;
  }

  @Post(':id/status')
  async status(@Param('id') id: string, @Body() body: { inUse?: boolean }) {
    const r = await this.skills.setUsing(id, !!body?.inUse);
    if (!r) throw new BadRequestException('Skill not found');
    return r;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.skills.remove(id);
    return { ok: true };
  }
}
