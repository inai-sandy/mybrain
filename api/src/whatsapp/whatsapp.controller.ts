import { Controller, Get, Query } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

/** Settings → WhatsApp (BEA-1114): read-only view of My Brain's templates + sent messages. */
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly wa: WhatsappService) {}

  @Get('numbers')
  numbers() {
    return this.wa.numbers();
  }

  @Get('templates')
  templates() {
    return this.wa.templates();
  }

  @Get('messages')
  messages(@Query('query') query?: string, @Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.wa.messages({ query, status, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }
}
