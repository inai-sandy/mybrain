import { Module } from '@nestjs/common';
import { PushService } from './push.service';
import { PushController } from './push.controller';
import { AlertsService } from './alerts.service';
import { ContactsModule } from '../contacts/contacts.module';

/**
 * Web Push (BEA-1088) + failure alerts (BEA-1071). Contacts is imported for the Postbox WhatsApp
 * channel only — no cycle (contacts never imports push/agents).
 */
@Module({
  imports: [ContactsModule],
  controllers: [PushController],
  providers: [PushService, AlertsService],
  exports: [PushService, AlertsService],
})
export class PushModule {}
