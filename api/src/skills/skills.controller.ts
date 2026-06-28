import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { SkillsService } from './skills.service';
import { SkillsImportService } from './skills-import.service';

@Controller('skills')
export class SkillsController {
  constructor(
    private readonly skills: SkillsService,
    private readonly importer: SkillsImportService,
  ) {}

  /** Step 1: look at a GitHub URL and list every skill it contains (BEA-635). */
  @Post('import/github/preview')
  async importPreview(@Body() body: { url?: string }) {
    return this.importer.preview(body?.url || '');
  }

  /** Step 2: import the chosen skills (and optionally deploy everywhere). */
  @Post('import/github/confirm')
  async importConfirm(@Body() body: { token?: string; paths?: string[]; deploy?: boolean; sourceUrl?: string }) {
    return this.importer.confirm(body?.token || '', body?.paths || [], !!body?.deploy, body?.sourceUrl);
  }

  @Post()
  async create(@Body() body: { title?: string; description?: string; content?: string; origin?: string; platform?: string; downloadUrl?: string }) {
    if (!body?.title?.trim() && !body?.content?.trim()) throw new BadRequestException('Add a title or paste the skill content');
    return this.skills.create(body || {});
  }

  @Get()
  async list() {
    return { skills: await this.skills.list() };
  }

  /** Scan the server's ~/.claude/skills and pull in new ones (AI-described, zipped). */
  @Post('scan')
  async scan() {
    return this.skills.scan();
  }

  @Get('scan-status')
  async scanStatus() {
    return { lastScan: await this.skills.lastScan() };
  }

  @Get('deploy-targets')
  async deployTargets() {
    return { targets: Object.keys(this.skills.deployTargets()) };
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

  @Post(':id/share')
  async share(@Param('id') id: string, @Body() body: { shared?: boolean }) {
    const r = await this.skills.setShared(id, body?.shared ?? true);
    if (!r) throw new BadRequestException('Skill not found');
    return r;
  }

  @Post(':id/upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@Param('id') id: string, @UploadedFile() file: any) {
    if (!file?.buffer) throw new BadRequestException('No file provided');
    const r = await this.skills.addFile(id, file.buffer, String(file.originalname || 'skill.md'));
    if (!r) throw new BadRequestException('Skill not found');
    return r;
  }

  @Post(':id/deploy')
  async deploy(@Param('id') id: string, @Body() body: { target?: string }) {
    return this.skills.deploy(id, body?.target || '');
  }

  @Post(':id/deploy-all')
  async deployAll(@Param('id') id: string) {
    return this.skills.deployAll(id);
  }

  @Get(':id/deploy-status')
  async deployStatus(@Param('id') id: string) {
    return { targets: await this.skills.deployStatus(id) };
  }

  @Post(':id/undeploy')
  async undeploy(@Param('id') id: string, @Body() body: { target?: string }) {
    return this.skills.undeploy(id, body?.target || '');
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const f = await this.skills.fileFor(id);
    if (!f) throw new NotFoundException('No file for this skill');
    res.download(f.filePath, f.name);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Query('uninstall') uninstall?: string) {
    await this.skills.remove(id, uninstall === 'true' || uninstall === '1');
    return { ok: true };
  }
}
