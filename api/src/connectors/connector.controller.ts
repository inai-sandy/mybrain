import { Controller, Get } from '@nestjs/common';
import { ConnectorService } from './connector.service';

@Controller('connectors')
export class ConnectorController {
  constructor(private readonly connectors: ConnectorService) {}

  /** Auth-gated (global guard). Returns connector names + configured flags only — never secrets. */
  @Get()
  async list() {
    return { connectors: await this.connectors.listStatus() };
  }
}
