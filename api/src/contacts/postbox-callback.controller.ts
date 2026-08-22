import { Body, Controller, ForbiddenException, Headers, Logger, Post } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from './postbox.service';
import { ReminderAgentService } from './reminder-agent.service';
import { AppEventsService } from '../events/events.service';
import { ownerReplyHandler } from './owner-reply';

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
    // Optional + LAST — positional spec construction stays valid (BEA-1076).
    private readonly appEvents?: AppEventsService,
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
        // Seen before? Either it is still in the conversation, or the owner DELETED it and the id
        // was kept precisely so a redelivery cannot bring it back and set the agent replying to
        // something he just removed. (BEA-1309)
        const dup = body.wamid ? await this.prisma.reminderMessage.findFirst({ where: { wamid: body.wamid, direction: 'in' } }) : null;
        if (dup) return { ok: true };
        const wasDeleted = body.wamid
          ? await Promise.resolve(this.prisma.deletedMessage?.findUnique?.({ where: { wamid: body.wamid } })).catch(() => null)
          : null;
        if (wasDeleted) {
          this.log.log(`ignored a redelivery of a message the owner deleted (${body.wamid})`);
          return { ok: true };
        }
        /**
         * The OWNER's own reply, ahead of the Contact lookup (BEA-1392 — `specs/AGENT-WORKERS.md` §H).
         *
         * He is not a Contact, so until now his messages matched nothing and this method returned
         * having done nothing at all. A worker that parks on a question needs exactly this road back.
         *
         * The rule is deliberately narrow, because everything below it is a live feature he uses
         * every day: this only intercepts when the message is from HIS number AND a question that
         * WhatsApp itself asked is still open. Anything else — his number with no open question, or
         * anyone else's number — falls straight through to the contact handling below, untouched.
         * A contact's reply can never reach the question matcher.
         *
         * A redelivered owner reply is harmless: answering is atomic, and the handler remembers the
         * message id, so a retry cannot answer the NEXT open question with the same words.
         */
        const owner = ownerReplyHandler();
        if (owner && (await owner.isOwnerNumber(from).catch(() => false))) {
          const r = await owner.onOwnerReply(text, { wamid: body.wamid || null }).catch((e: any) => {
            this.log.warn(`owner reply: ${e?.message || e}`);
            return { answered: false };
          });
          if (r?.answered) return { ok: true, answered: true };
        }
        // Store the reply on this CONTACT's conversation (shared across their reminders). (BEA-742)
        // WhatsApp's `from` always carries the country code, but a contact may be saved without it
        // (e.g. a 10-digit number). Try an exact match, then fall back to the last 10 digits so those
        // replies aren't silently dropped (which also kept template nudges firing at them). (BEA-787)
        let contact = await this.prisma.contact.findFirst({ where: { whatsappNumber: from } });
        if (!contact && from.length >= 10) {
          contact = await this.prisma.contact.findFirst({ where: { whatsappNumber: { endsWith: from.slice(-10) } } });
        }
        if (contact) {
          // Keep what makes a tap exact, so "did they tap or write?" is answerable from the stored
          // conversation and not only in the moment it arrived. (BEA-1300)
          await this.prisma.reminderMessage
            .create({
              data: {
                contactId: contact.id,
                direction: 'in',
                body: text,
                wamid: body.wamid || null,
                replyToWamid: body.replyToWamid || null,
                buttonId: body.buttonId || null,
              },
            })
            .catch(() => undefined);
          // Kick off the two-way agent (C2) for the whole contact — fire-and-forget so the callback returns fast.
          void this.agent.onContactReply(contact.id).catch((e) => this.log.warn(`agent onContactReply: ${e?.message}`));
          // Event trigger (BEA-1076): agents set to "when a contact replies" fire now.
          this.appEvents?.emit('whatsapp.reply', { summary: `${contact.name || 'A contact'} replied on WhatsApp: "${text.slice(0, 300)}"`, contactId: contact.id });
        }
      }
    }
    return { ok: true };
  }
}
