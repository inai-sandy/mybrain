import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
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

  // ---- biometric / passkey devices ----
  @Get('devices')
  listDevices() {
    return this.vault.listDevices();
  }

  @Post('devices')
  addDevice(@Body() body: { credentialId: string; label: string; wrap: { iv: string; ct: string } }) {
    return this.vault.addDevice(body);
  }

  @Delete('devices/:id')
  removeDevice(@Param('id') id: string) {
    return this.vault.removeDevice(id);
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

  // ---- encrypted document attachments (the bytes are already ciphertext from the browser) ----
  @Post('items/:id/file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  uploadFile(@Param('id') id: string, @UploadedFile() file: { buffer: Buffer }) {
    return this.vault.saveFile(id, file?.buffer as Buffer);
  }

  @Get('items/:id/file')
  async downloadFile(@Param('id') id: string, @Res() res: Response) {
    const buf = await this.vault.readFile(id);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buf);
  }
}
