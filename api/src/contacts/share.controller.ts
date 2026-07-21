import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { ContactsService } from './contacts.service';
import { ClaimsService } from '../tasks/claims.service';
import { Public } from '../auth/public.decorator';

/**
 * The page a contact opens. PUBLIC by design — no login, no account, because the whole point is
 * that clearing four items takes ten seconds on a phone. It exposes only their own work. (BEA-1027)
 */
@Controller('t')
export class ShareController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly claims: ClaimsService,
  ) {}

  @Public()
  @Get(':slug')
  board(@Param('slug') slug: string) {
    return this.contacts.publicBoard(slug);
  }

  /**
   * They tick something off. That is a CLAIM — it is sent to the owner for his check and never
   * closes the task by itself. Rate-limited because this endpoint needs no login: a stuck finger
   * or a forwarded link must not be able to flood the review list. (BEA-1028)
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':slug/tick')
  async tick(@Param('slug') slug: string, @Body() body: { taskId?: string; note?: string; done?: boolean }) {
    const taskId = String(body?.taskId || '');
    if (!taskId) throw new BadRequestException('Which one?');
    const contact = await this.contacts.contactForShare(slug); // 404s on a bad or disabled link
    const owns = await this.contacts.ownsTask(contact.id, taskId);
    if (!owns) throw new BadRequestException('That is not on your list');

    if (body?.done === false) {
      await this.claims.withdraw(taskId);
      return { ok: true, claimed: false };
    }
    const row = await this.claims.claim({ taskId, contactId: contact.id, quote: String(body?.note || '').trim() || 'Ticked it off on their page', source: 'page' });
    return { ok: true, claimed: !!row };
  }
}
