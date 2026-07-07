import { Body, Controller, ForbiddenException, Headers, Logger, Post } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from './postbox.service';
import { ReminderAgentService } from './reminder-agent.service';

/**
 * Receives Postbox callbacks for My Brain's reminder conversations (BEA-729):
 *  - kind 'status'  → update the matching ReminderSend (delivered/read/failed) by wamid.
 *  - kind 'message' → a contact replied; store it on the reminder's thread. The two-way
 *                     agent (C2) reads these and responds. Verified by the Postbox app key.
 */
@Controller('postbox')
export class PostboxCallbackController {
  private readonly log = new Logger('PostboxCallback');

  constructor(
    private readonly prisma: PrismaService,
    private readonly postbox: PostboxService,
    private readonly agent: ReminderAgentService,
  ) {}

  @Public()
  @Post('callback')
  async callback(@Body() body: any, @Headers('x-postbox-key') key?: string) {
    if (!this.postbox.callbackKey || key !== this.postbox.callbackKey) {
      throw new ForbiddenException('Bad Postbox key.');
    }
    if (body?.kind === 'status' && body.wamid) {
      const st = String(body.status || '');
      // The scheduled send row (existing behaviour).
      const send = await this.prisma.reminderSend.findFirst({ where: { providerId: body.wamid } });
      if (send && ['delivered', 'read', 'failed'].includes(st)) {
        await this.prisma.reminderSend
          .update({ where: { id: send.id }, data: { status: st, error: body.error || undefined } })
          .catch(() => undefined);
      }
      // The chat message row — light up delivery ticks (BEA-916). Only advance forward
      // (sent→delivered→read) so an out-of-order 'delivered' can't downgrade a 'read'; 'failed' always wins.
      const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };
      if (RANK[st]) {
        const lower = Object.keys(RANK).filter((k) => RANK[k] < RANK[st]);
        const where: any = st === 'failed' ? { wamid: body.wamid, direction: 'out' } : { wamid: body.wamid, direction: 'out', OR: [{ status: null }, { status: { in: lower } }] };
        await this.prisma.reminderMessage
          .updateMany({ where, data: { status: st, error: st === 'failed' ? body.error || 'failed' : undefined } })
          .catch(() => undefined);
      }
    } else if (body?.kind === 'message') {
      const from = String(body.from || '').replace(/[^\d]/g, '');
      const text = (body.text || '').trim();
      if (from && text) {
        // Dedupe: Postbox may retry a callback — never store/act on the same inbound twice.
        const dup = body.wamid ? await this.prisma.reminderMessage.findFirst({ where: { wamid: body.wamid, direction: 'in' } }) : null;
        if (dup) return { ok: true };
        // Store the reply on this CONTACT's conversation (shared across their reminders). (BEA-742)
        // WhatsApp's `from` always carries the country code, but a contact may be saved without it
        // (e.g. a 10-digit number). Try an exact match, then fall back to the last 10 digits so those
        // replies aren't silently dropped (which also kept template nudges firing at them). (BEA-787)
        let contact = await this.prisma.contact.findFirst({ where: { whatsappNumber: from } });
        if (!contact && from.length >= 10) {
          contact = await this.prisma.contact.findFirst({ where: { whatsappNumber: { endsWith: from.slice(-10) } } });
        }
        if (contact) {
          await this.prisma.reminderMessage
            .create({ data: { contactId: contact.id, direction: 'in', body: text, wamid: body.wamid || null } })
            .catch(() => undefined);
          // Kick off the two-way agent (C2) for the whole contact — fire-and-forget so the callback returns fast.
          void this.agent.onContactReply(contact.id).catch((e) => this.log.warn(`agent onContactReply: ${e?.message}`));
        }
      }
    }
    return { ok: true };
  }
}
