import { BadRequestException, Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ConnectorService, isKnownConnector } from './connector.service';

@Controller('connectors')
export class ConnectorController {
  constructor(private readonly connectors: ConnectorService) {}

  /** Auth-gated. Names + configured flags only — never secrets. */
  @Get()
  async list() {
    return { connectors: await this.connectors.listStatus() };
  }

  /** Set/replace a connector's secrets (encrypted). Validated; never echoes secrets back. */
  @Put(':name')
  async set(@Param('name') name: string, @Body() body: Record<string, any>) {
    if (!isKnownConnector(name)) throw new BadRequestException('Unknown connector');
    const secrets = Object.fromEntries(
      Object.entries(body || {}).filter(([, v]) => v !== undefined && v !== null && String(v).trim().length > 0),
    );
    if (Object.keys(secrets).length === 0) throw new BadRequestException('No values provided');
    await this.connectors.set(name, secrets);
    return { ok: true, name, configured: true };
  }

  /** Disconnect a connector. */
  @Delete(':name')
  async remove(@Param('name') name: string) {
    if (!isKnownConnector(name)) throw new BadRequestException('Unknown connector');
    await this.connectors.remove(name);
    return { ok: true, name, configured: false };
  }
}
