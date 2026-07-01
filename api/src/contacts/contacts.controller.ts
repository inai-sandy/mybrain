import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ContactsService } from './contacts.service';

@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(@Query('q') q?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.contacts.list(q || undefined, Number(page) || 1, Number(pageSize) || 20);
  }

  @Post()
  create(@Body() body: { name?: string; whatsappNumber?: string; notes?: string; tags?: string[] }) {
    return this.contacts.create(body || {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; whatsappNumber?: string; notes?: string; tags?: string[] }) {
    return this.contacts.update(id, body || {});
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.contacts.remove(id);
  }
}
