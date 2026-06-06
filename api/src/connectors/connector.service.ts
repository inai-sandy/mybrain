import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt, decrypt } from './crypto.util';

export type ConnectorName = 'supermemory' | 'rag' | 'notion' | 'telegram' | 'raindrop' | 'anthropic';

@Injectable()
export class ConnectorService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  /** Seed connectors from env on first boot (so existing keys load without the UI). */
  async onModuleInit() {
    if (process.env.SUPERMEMORY_API_KEY) {
      await this.setIfAbsent('supermemory', {
        apiKey: process.env.SUPERMEMORY_API_KEY,
        project: process.env.SUPERMEMORY_PROJECT || 'sandeep',
      });
    }
    if (process.env.NOTION_TOKEN) await this.setIfAbsent('notion', { token: process.env.NOTION_TOKEN });
    if (process.env.TELEGRAM_BOT_TOKEN) await this.setIfAbsent('telegram', { botToken: process.env.TELEGRAM_BOT_TOKEN });
    if (process.env.RAINDROP_TOKEN) await this.setIfAbsent('raindrop', { token: process.env.RAINDROP_TOKEN });
    if (process.env.ANTHROPIC_API_KEY) await this.setIfAbsent('anthropic', { apiKey: process.env.ANTHROPIC_API_KEY });
  }

  /** Store/replace a connector's secrets (encrypted at rest). */
  async set(name: ConnectorName, secrets: Record<string, any>): Promise<void> {
    const enc = encrypt(JSON.stringify(secrets));
    await this.prisma.connector.upsert({
      where: { name },
      create: { name, secrets: enc },
      update: { secrets: enc },
    });
  }

  private async setIfAbsent(name: ConnectorName, secrets: Record<string, any>) {
    const existing = await this.prisma.connector.findUnique({ where: { name } });
    if (!existing) await this.set(name, secrets);
  }

  /** Get a connector's decrypted secrets, or null if not configured. */
  async get<T = Record<string, any>>(name: ConnectorName): Promise<T | null> {
    const row = await this.prisma.connector.findUnique({ where: { name } });
    if (!row) return null;
    return JSON.parse(decrypt(row.secrets)) as T;
  }

  /** List connector names + whether each is configured (never returns secrets). */
  async listStatus(): Promise<{ name: string; configured: boolean }[]> {
    const all: ConnectorName[] = ['supermemory', 'rag', 'notion', 'telegram', 'raindrop', 'anthropic'];
    const rows = await this.prisma.connector.findMany({ select: { name: true } });
    const have = new Set(rows.map((r) => r.name));
    return all.map((name) => ({ name, configured: have.has(name) }));
  }
}
