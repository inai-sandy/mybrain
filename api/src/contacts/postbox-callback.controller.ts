import { Body, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PostboxService } from './postbox.service';

/**
 * Receives Postbox callbacks for My Brain's reminder conversations (BEA-729):
 *  - kind 'status'  → update the matching ReminderSend (delivered/read/failed) by wamid.
 *  - kind 'message' → a contact replied; store it on the reminder's thread. The two-way
 *                     agent (C2) reads these and responds. Verified by the Postbox app key.
 */
@Controller('postbox')
export class PostboxCallbackController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postbox: PostboxService,
  ) {}

  @Public()
  @Post('callback')
  async callback(@Body() body: any, @Headers('x-postbox-key') key?: string) {
    if (!this.postbox.callbackKey || key !== this.postbox.callbackKey) {
      throw new ForbiddenException('Bad Postbox key.');
    }
    if (body?.kind === 'status' && body.wamid) {
      const send = await this.prisma.reminderSend.findFirst({ where: { providerId: body.wamid } });
      if (send && ['delivered', 'read', 'failed'].includes(body.status)) {
        await this.prisma.reminderSend
          .update({ where: { id: send.id }, data: { status: body.status, error: body.error || undefined } })
          .catch(() => undefined);
      }
    } else if (body?.kind === 'message') {
      const from = String(body.from || '').replace(/[^\d]/g, '');
      const text = (body.text || '').trim();
      if (from && text) {
        // Attach the reply to this contact's most recent active reminder.
        const reminder = await this.prisma.reminder.findFirst({
          where: { status: 'active', contact: { whatsappNumber: from } },
          orderBy: { updatedAt: 'desc' },
        });
        if (reminder) {
          await this.prisma.reminderMessage
            .create({ data: { reminderId: reminder.id, direction: 'in', body: text, wamid: body.wamid || null } })
            .catch(() => undefined);
        }
      }
    }
    return { ok: true };
  }
}
