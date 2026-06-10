import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt, decrypt } from './crypto.util';

export type ConnectorName = 'supermemory' | 'rag' | 'notion' | 'telegram' | 'raindrop' | 'tavily' | 'anthropic' | 'openrouter' | 'openai' | 'openai_admin' | 'elevenlabs' | 'deepgram';

export const KNOWN_CONNECTORS: ConnectorName[] = ['supermemory', 'rag', 'notion', 'telegram', 'raindrop', 'tavily', 'anthropic', 'openrouter', 'openai', 'openai_admin', 'elevenlabs', 'deepgram'];

export function isKnownConnector(n: string): n is ConnectorName {
  return (KNOWN_CONNECTORS as string[]).includes(n);
}

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
    if (process.env.RAINDROP_TOKEN || process.env.RAINDROP_API_TOKEN)
      await this.setIfAbsent('raindrop', { token: process.env.RAINDROP_TOKEN || process.env.RAINDROP_API_TOKEN });
    if (process.env.TAVILY_API_KEY) await this.setIfAbsent('tavily', { apiKey: process.env.TAVILY_API_KEY });
    if (process.env.ANTHROPIC_API_KEY) await this.setIfAbsent('anthropic', { apiKey: process.env.ANTHROPIC_API_KEY });
    if (process.env.OPENROUTER_API_KEY) await this.setIfAbsent('openrouter', { apiKey: process.env.OPENROUTER_API_KEY });
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

  /** Disconnect a connector (delete its stored secrets). */
  async remove(name: ConnectorName): Promise<void> {
    await this.prisma.connector.deleteMany({ where: { name } });
  }

  /** Get a connector's decrypted secrets, or null if not configured. */
  async get<T = Record<string, any>>(name: ConnectorName): Promise<T | null> {
    const row = await this.prisma.connector.findUnique({ where: { name } });
    if (!row) return null;
    return JSON.parse(decrypt(row.secrets)) as T;
  }

  /**
   * Live-test a connector's saved key by making a real (cheap) call to the service.
   * Never returns the secret — only a plain ok/message the UI can show.
   */
  async test(name: ConnectorName): Promise<{ ok: boolean; message: string }> {
    const secrets = await this.get<Record<string, string>>(name);
    if (!secrets) return { ok: false, message: 'Nothing saved yet — add a key first, then test.' };
    try {
      if (name === 'raindrop') {
        const r = await fetch('https://api.raindrop.io/rest/v1/user', {
          headers: { Authorization: `Bearer ${secrets.token}` },
        });
        if (r.ok) {
          const d: any = await r.json().catch(() => ({}));
          const who = d?.user?.fullName || d?.user?.email || 'your account';
          return { ok: true, message: `Connected to Raindrop as ${who}.` };
        }
        if (r.status === 401) return { ok: false, message: 'Raindrop rejected that token. Double-check the key.' };
        return { ok: false, message: `Raindrop returned an error (HTTP ${r.status}).` };
      }
      if (name === 'tavily') {
        const r = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: secrets.apiKey, query: 'ping', max_results: 1, include_answer: false }),
        });
        if (r.ok) return { ok: true, message: 'Tavily key works — pages can be read.' };
        if (r.status === 401) return { ok: false, message: 'Tavily rejected that key. Double-check it.' };
        return { ok: false, message: `Tavily returned an error (HTTP ${r.status}).` };
      }
      return { ok: false, message: 'No live test available for this connector.' };
    } catch {
      return { ok: false, message: 'Could not reach the service — check the network and try again.' };
    }
  }

  /** List connector names + whether each is configured (never returns secrets). */
  async listStatus(): Promise<{ name: string; configured: boolean }[]> {
    const rows = await this.prisma.connector.findMany({ select: { name: true } });
    const have = new Set(rows.map((r) => r.name));
    return KNOWN_CONNECTORS.map((name) => ({ name, configured: have.has(name) }));
  }
}
