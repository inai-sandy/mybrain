import { Global, Module } from '@nestjs/common';
import { AppEventsService } from './events.service';

/**
 * App-wide event bus (BEA-1076) — a tiny in-process emitter so features can announce "something
 * happened" (new journal entry, inbound WhatsApp, new bookmark) without importing each other.
 * Global: emitters and listeners just inject AppEventsService, no module wiring, no cycles.
 */
@Global()
@Module({
  providers: [AppEventsService],
  exports: [AppEventsService],
})
export class EventsModule {}
