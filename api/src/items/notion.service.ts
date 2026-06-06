import { BadRequestException, Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';

// Load Notion libs via a real dynamic import (safe across CJS/ESM packaging).
const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

@Injectable()
export class NotionService {
  constructor(private readonly connectors: ConnectorService) {}

  /** Pull a Notion page id (32 hex chars) out of a URL or raw id. */
  extractPageId(urlOrId: string): string {
    const s = (urlOrId || '').trim();
    const dashed = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const plain = s.match(/[0-9a-f]{32}/i);
    const id = dashed?.[0] || plain?.[0];
    if (!id) throw new BadRequestException('Could not find a Notion page id in that link');
    return id.replace(/-/g, '');
  }

  async fetchMarkdown(urlOrId: string): Promise<{ title: string; markdown: string }> {
    const c = await this.connectors.get<{ token: string }>('notion');
    if (!c?.token) throw new BadRequestException('Connect Notion in Settings first');
    const pageId = this.extractPageId(urlOrId);

    const { Client } = await dynImport('@notionhq/client');
    const { NotionToMarkdown } = await dynImport('notion-to-md');
    const notion = new Client({ auth: c.token });
    const n2m = new NotionToMarkdown({ notionClient: notion });

    let title = 'Notion page';
    try {
      const page: any = await notion.pages.retrieve({ page_id: pageId });
      const props = page.properties || {};
      for (const k of Object.keys(props)) {
        const p = props[k];
        if (p?.type === 'title' && p.title?.length) {
          title = p.title.map((t: any) => t.plain_text).join('').trim() || title;
          break;
        }
      }
    } catch {
      throw new BadRequestException('Could not open that Notion page — is it shared with your integration?');
    }

    const blocks = await n2m.pageToMarkdown(pageId);
    const markdown = (n2m.toMarkdownString(blocks)?.parent || '').trim();
    if (!markdown) throw new BadRequestException('That Notion page is empty or not shared with the integration');
    return { title, markdown };
  }
}
