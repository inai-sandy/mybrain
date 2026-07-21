import { Controller, Get, Param } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { Public } from '../auth/public.decorator';

/**
 * The page a contact opens. PUBLIC by design — no login, no account, because the whole point is
 * that clearing four items takes ten seconds on a phone. It exposes only their own work. (BEA-1027)
 */
@Controller('t')
export class ShareController {
  constructor(private readonly contacts: ContactsService) {}

  @Public()
  @Get(':slug')
  board(@Param('slug') slug: string) {
    return this.contacts.publicBoard(slug);
  }
}
