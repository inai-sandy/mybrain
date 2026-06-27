import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';

const ACTOR = 'apify~instagram-scraper';

export type IgEnrichment = { caption: string; imageUrl: string | null; isVideo: boolean; owner?: string };

/**
 * Fetches the REAL caption + media for an Instagram post/reel via Apify, so bookmarks get a
 * matching description and a downloadable (non-expiring) image. Returns null on anything that
 * isn't a clean success, so the caller falls back to the normal behaviour. (BEA-609)
 */
@Injectable()
export class InstagramEnricher {
  constructor(private readonly connectors: ConnectorService) {}

  isInstagram(url: string): boolean {
    return /instagram\.com\/(?:p|reel|reels|tv)\//i.test(url || '');
  }

  async configured(): Promise<boolean> {
    return !!(await this.connectors.get('apify').catch(() => null))?.apiKey;
  }

  async enrich(url: string): Promise<IgEnrichment | null> {
    if (!this.isInstagram(url)) return null;
    const token = (await this.connectors.get('apify').catch(() => null))?.apiKey;
    if (!token) return null;
    try {
      const r = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directUrls: [url], resultsType: 'posts', resultsLimit: 1, addParentData: false }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) return null;
      const items = await r.json();
      return this.parse(Array.isArray(items) ? items[0] : null);
    } catch {
      return null;
    }
  }

  /** Pull caption + best image out of one Apify dataset item. Exposed for tests. */
  parse(it: any): IgEnrichment | null {
    if (!it || typeof it !== 'object') return null;
    const caption = String(it.caption || it.text || it.title || '').trim().slice(0, 4000);
    const isVideo = it.type === 'Video' || it.productType === 'clips' || !!it.videoUrl;
    const imageUrl =
      it.displayUrl ||
      (Array.isArray(it.images) && it.images[0]) ||
      it.thumbnailUrl ||
      (Array.isArray(it.childPosts) && it.childPosts[0]?.displayUrl) ||
      null;
    if (!caption && !imageUrl) return null;
    return { caption, imageUrl: imageUrl || null, isVideo, owner: it.ownerUsername || undefined };
  }
}
