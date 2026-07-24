import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { PushService } from './push.service';

/** Web Push surface (BEA-1088). Behind the global auth guard. */
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('public-key')
  publicKey() {
    return this.push.publicKey();
  }

  @Get('status')
  status() {
    return this.push.count();
  }

  @Post('subscribe')
  subscribe(@Body() body: any, @Headers('user-agent') ua?: string) {
    return this.push.subscribe(body, ua);
  }

  @Post('unsubscribe')
  unsubscribe(@Body() body: { endpoint?: string }) {
    return this.push.unsubscribe(body?.endpoint);
  }

  /** Fire a test notification to every subscribed device. */
  @Post('test')
  test() {
    return this.push.send({ title: 'My Brain', body: 'Push is working — this is your test notification. 🎉', url: '/agent', isAsk: true });
  }
}
