import { Body, Controller, Get, Post } from '@nestjs/common';
import { ToolCatalogService } from './tool-catalog.service';

/** The one tool catalog (BEA-1167) — read by the agent toolbox, the chat's tool step and the flow canvas. */
@Controller('tools')
export class ToolCatalogController {
  constructor(private readonly catalog: ToolCatalogService) {}

  @Get('catalog')
  list() {
    return this.catalog.catalog();
  }

  /** Check a picked set before it is saved — which ids are real, which still need connecting. */
  @Post('validate')
  validate(@Body() body: { ids?: string[] }) {
    return this.catalog.validate(Array.isArray(body?.ids) ? body.ids : []);
  }
}
