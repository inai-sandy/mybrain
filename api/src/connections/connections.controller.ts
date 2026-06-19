import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ConnectionsService } from './connections.service';

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly conn: ConnectionsService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.conn.list(status || 'active');
  }
  @Post('discover')
  discover() {
    return this.conn.discover();
  }
  @Post('seen')
  seen(@Body() body: { ids?: string[] }) {
    return this.conn.markSeen(body?.ids || []);
  }
  @Patch(':id/dismiss')
  dismiss(@Param('id') id: string) {
    return this.conn.dismiss(id);
  }
}
