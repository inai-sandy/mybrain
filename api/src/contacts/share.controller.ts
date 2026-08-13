import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { ContactsService } from './contacts.service';
import { ClaimsService } from '../tasks/claims.service';
import { DelegationService } from '../tasks/delegation.service';
import { TeamUpdatesService } from './team-updates.service';
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
    private readonly updates: TeamUpdatesService,
    private readonly delegation: DelegationService,
  ) {}

  /**
   * They just want to tell him something. (BEA-1159)
   *
   * Until now the only way to speak was to tick a task and attach a note, so the product was
   * pushing people into marking work finished in order to say "the KIOT thing slipped". Every
   * share-page note on record turned out to be a real message, not a bare tick.
   *
   * Same rate limit as the tick: this needs no login, so a forwarded link must not be able to
   * flood him.
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':slug/message')
  async message(@Param('slug') slug: string, @Body() body: { text?: string }) {
    const text = String(body?.text || '').trim();
    if (!text) throw new BadRequestException('Write something first');
    const contact = await this.contacts.contactForShare(slug); // 404s on a bad or disabled link
    const row = await this.updates.record({ contactId: contact.id, text: text.slice(0, 2000), channel: 'link' });
    return { ok: !!row, needsHim: !!row?.needsYou };
  }

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
      // Un-ticking withdraws the claim, so the chase must come back on — otherwise a mis-tap would
      // silence a chase permanently with nothing waiting in the owner's review list. (BEA-1293)
      await this.claims.withdraw(taskId);
      await this.delegation.resumeChases(taskId).catch(() => 0);
      return { ok: true, claimed: false };
    }
    // A daily report can't be "ticked off" — claim() records today's instead and returns null, so
    // the response has to say which of the two actually happened. (BEA-1118)
    const kind = await this.contacts.taskKind(taskId);
    const words = String(body?.note || '').trim() || (kind === 'recurring' ? "Sent today's update" : 'Ticked it off on their page');
    // Whatever they typed on their own link is a MESSAGE, not just a quote welded to a claim.
    // Every share-page note on record turned out to be a real message — "Yes, 6 Members will work
    // for KIOT from 1st August", "Will update tomorrow" — and none of them were ever visible in
    // the conversation. (BEA-1159)
    const typed = String(body?.note || '').trim();
    if (typed) {
      await this.updates
        .record({ contactId: contact.id, text: typed, channel: 'link', taskId, isReport: kind === 'recurring' })
        .catch(() => undefined);
    }
    // Through the one door, so a tick on their page pauses the chase exactly like a "done" on
    // WhatsApp does. Two routes to one outcome is what BEA-1296 removed. (BEA-1293)
    const res: any = await this.delegation.recordClaim({ taskId, contactId: contact.id, quote: words, source: 'page' });
    if (kind === 'recurring') return { ok: true, claimed: false, recordedToday: true };
    return { ok: true, claimed: !!res?.claimed };
  }
}
