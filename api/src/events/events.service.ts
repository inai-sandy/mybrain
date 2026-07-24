import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

/** The events agents can subscribe to (BEA-1076). Payloads are small plain summaries, never blobs. */
export type AppEventName = 'journal.added' | 'whatsapp.reply' | 'bookmark.added';
export type AppEventPayload = { summary: string; [k: string]: unknown };

@Injectable()
export class AppEventsService {
  private readonly log = new Logger('AppEvents');
  private readonly bus = new EventEmitter();

  constructor() {
    this.bus.setMaxListeners(30);
  }

  emit(name: AppEventName, payload: AppEventPayload) {
    try {
      this.bus.emit(name, payload);
    } catch (e: any) {
      this.log.warn(`emit ${name} failed: ${e?.message}`);
    }
  }

  on(name: AppEventName, cb: (payload: AppEventPayload) => void) {
    // listeners must never crash the emitter's call path
    this.bus.on(name, (p) => {
      try { cb(p); } catch (e: any) { this.log.warn(`listener for ${name} failed: ${e?.message}`); }
    });
  }
}
