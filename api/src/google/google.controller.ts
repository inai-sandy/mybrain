import { Controller, Get } from '@nestjs/common';
import { GoogleService } from './google.service';

@Controller('google')
export class GoogleController {
  constructor(private readonly google: GoogleService) {}

  @Get('status')
  async status() {
    return this.google.status();
  }
}
