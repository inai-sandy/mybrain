import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { sendJson } from '../common/send-json';
import { ToolCatalogService } from './tool-catalog.service';

/** The one tool catalog (BEA-1167) — read by the agent toolbox, the chat's tool step and the flow canvas. */
@Controller('tools')
export class ToolCatalogController {
  constructor(private readonly catalog: ToolCatalogService) {}

  /** Gzipped on the wire — it holds every action of every connected service (BEA-1354, ~750KB plain). */
  @Get('catalog')
  async list(@Res() res: Response) {
    sendJson(res, await this.catalog.catalog());
  }

  /** Check a picked set before it is saved — which ids are real, which still need connecting. */
  @Post('validate')
  validate(@Body() body: { ids?: string[] }) {
    return this.catalog.validate(Array.isArray(body?.ids) ? body.ids : []);
  }
}
