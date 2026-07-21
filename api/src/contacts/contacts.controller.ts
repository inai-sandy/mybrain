import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ContactsService } from './contacts.service';

@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(@Query('q') q?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.contacts.list(q || undefined, Number(page) || 1, Number(pageSize) || 20);
  }

  /** Every contact, name + spellings only — for pickers and @mention matching. Must come before
   *  ':id' so "all" isn't read as an id. Uncapped on purpose: a picker that silently stops at 100
   *  would quietly hide people. (BEA-1019) */
  @Get('all')
  all() {
    return this.contacts.allForPicker();
  }

  /** The contact's own link — created on first ask. (BEA-1027) */
  @Get(':id/share')
  share(@Param('id') id: string) {
    return this.contacts.share(id);
  }

  /** Issue a new link and kill the old one. */
  @Post(':id/share/rotate')
  rotateShare(@Param('id') id: string) {
    return this.contacts.rotateShare(id);
  }

  /** Turn their page off or back on. */
  @Post(':id/share/enabled')
  setShareEnabled(@Param('id') id: string, @Body() body: { enabled?: boolean }) {
    return this.contacts.setShareEnabled(id, body?.enabled !== false);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.contacts.get(id);
  }

  @Get(':id/alias-suggestions')
  aliasSuggestions(@Param('id') id: string) {
    return this.contacts.aliasSuggestions(id);
  }

  @Post(':id/alias')
  addAlias(@Param('id') id: string, @Body() body: { alias?: string }) {
    return this.contacts.addAlias(id, body?.alias || '');
  }

  @Post()
  create(@Body() body: { name?: string; whatsappNumber?: string; notes?: string; tags?: string[]; aliases?: string[] }) {
    return this.contacts.create(body || {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; whatsappNumber?: string; notes?: string; tags?: string[]; aliases?: string[] }) {
    return this.contacts.update(id, body || {});
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.contacts.remove(id);
  }
}
