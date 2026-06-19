import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { VaultService, VaultItemInput, VaultMetaInput } from './vault.service';

@Controller('vault')
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  // ---- meta ----
  @Get('meta')
  getMeta() {
    return this.vault.getMeta();
  }

  @Post('meta')
  createMeta(@Body() body: VaultMetaInput) {
    return this.vault.createMeta(body);
  }

  @Put('meta/rewrap')
  rewrap(@Body() body: any) {
    return this.vault.rewrapMeta(body);
  }

  // ---- items ----
  @Get('items')
  listItems(
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Query('collection') collection?: string,
    @Query('favorite') favorite?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.vault.listItems({
      search,
      type,
      collection,
      favorite: favorite === undefined ? undefined : favorite === 'true' || favorite === '1',
      sort,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('items/count')
  count() {
    return this.vault.count();
  }

  @Get('items/:id')
  getItem(@Param('id') id: string) {
    return this.vault.getItem(id);
  }

  @Post('items')
  createItem(@Body() body: VaultItemInput) {
    return this.vault.createItem(body);
  }

  @Put('items/:id')
  updateItem(@Param('id') id: string, @Body() body: Partial<VaultItemInput>) {
    return this.vault.updateItem(id, body);
  }

  @Delete('items/:id')
  deleteItem(@Param('id') id: string) {
    return this.vault.deleteItem(id);
  }
}
