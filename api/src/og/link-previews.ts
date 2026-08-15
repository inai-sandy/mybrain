import type { Request, Response, NextFunction } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Link previews (Open Graph) for every shared surface. (BEA-1133 / BEA-1134)
 *
 * WhatsApp/Telegram/iMessage/Twitter crawlers do NOT run JavaScript — they read the HTML the server
 * sends. So a client-rendered page can never produce a preview card on its own. `web/index.html`
 * carries a default card between `<!--og-->` markers; for a shared item we swap that block for the
 * item's own title, description and image before sending the same shell.
 *
 * Anything not listed here (e.g. a contact's private task board /t/:slug, a Gmail request) falls
 * through to the default card ON PURPOSE: generating a preview means WhatsApp's servers fetch and
 * cache that content, so personal pages must never put their contents in a card.
 */

export type OgMeta = { title: string; description: string; image: string; url: string };

const OG_START = '<!--og-->';
const OG_END = '<!--/og-->';

export function escapeAttr(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** Squash markdown/whitespace into one clean line for a preview description. */
export function cleanDescription(raw: string | null | undefined, fallback = 'Shared from My Brain'): string {
  const s = String(raw || '')
    .replace(/[#*_`>[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return s || fallback;
}

export function ogTags(m: OgMeta, type = 'article'): string {
  const e = escapeAttr;
  return [
    `<meta property="og:type" content="${e(type)}">`,
    `<meta property="og:site_name" content="My Brain">`,
    `<meta property="og:title" content="${e(m.title)}">`,
    `<meta property="og:description" content="${e(m.description)}">`,
    `<meta property="og:url" content="${e(m.url)}">`,
    `<meta property="og:image" content="${e(m.image)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(m.title)}">`,
    `<meta name="twitter:description" content="${e(m.description)}">`,
    `<meta name="twitter:image" content="${e(m.image)}">`,
  ].join('');
}

/**
 * Put this item's tags into the shell, REPLACING the default block so a page never carries two
 * og:title tags. If the markers are missing (an older build), fall back to appending before </head>.
 */
export function injectOg(html: string, meta: OgMeta): string {
  const tags = ogTags(meta);
  const titled = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeAttr(meta.title)}</title>`);
  const start = titled.indexOf(OG_START);
  const end = titled.indexOf(OG_END);
  if (start !== -1 && end > start) {
    return titled.slice(0, start) + OG_START + tags + OG_END + titled.slice(end + OG_END.length);
  }
  return titled.replace('</head>', tags + '</head>');
}

/** One entry per shareable surface. `resolve` returns null → the default card is used. */
export type OgRoute = { path: string; resolve: (params: Record<string, string>, origin: string) => Promise<OgMeta | null> };

type Deps = {
  /** DocumentsService — kept for documents because it also honours an HTML doc's own og:image. */
  docs: { ogMeta(slug: string, origin: string): Promise<OgMeta | null>; resolveShortCode(code: string): Promise<{ slug: string } | null> };
  /** Prisma — the other surfaces only need "is it shared" + a title, so no service wiring needed. */
  prisma: any;
  /** NewsPublicService — AI Tweets Daily builds its own card, so the logic lives in one place. */
  news?: { ogMeta(day: string, origin: string): Promise<OgMeta | null> };
  /** RadarFeedService — the public AI News Daily page's card (BEA-1325). */
  radar?: { ogMeta(origin: string): Promise<OgMeta | null> };
};

const card = (origin: string, type: string, id: string) => `${origin}/api/og/${type}/${encodeURIComponent(id)}/card.png`;

export function buildOgRoutes({ docs, prisma, news, radar }: Deps): OgRoute[] {
  return [
    // Documents — unchanged behaviour (BEA-900).
    { path: '/d/:slug', resolve: (p, origin) => docs.ogMeta(p.slug, origin) },

    // The public AI News Daily radar (BEA-1325) — meant to be shared, like /paper. The card
    // carries today's hottest stories, built by RadarFeedService so the logic lives in one place.
    { path: '/radar', resolve: (_p, origin) => (radar ? radar.ogMeta(origin) : Promise.resolve(null)) },

    // AI Tweets Daily (BEA-1261). This page is MEANT to be shared, so it gets a real card: the day's
    // headline and the top of the 60-second read. Server-rendered, because crawlers do not run
    // JavaScript — a card built in React is a card nobody ever sees.
    //
    // The card is built by NewsPublicService, not reimplemented here. A second copy of "how does a
    // share card read an edition" is a copy that drifts the first time one of them is touched.
    { path: '/paper/:day', resolve: (p, origin) => (news ? news.ogMeta(p.day, origin) : Promise.resolve(null)) },

    // The SHORT document link — the one people actually paste. Same card, its own URL.
    {
      path: '/s/:code',
      resolve: async (p, origin) => {
        const d = await docs.resolveShortCode(p.code);
        if (!d) return null;
        const m = await docs.ogMeta(d.slug, origin);
        return m ? { ...m, url: `${origin}/s/${p.code}` } : null;
      },
    },

    // A shared skill.
    {
      path: '/skill/:id',
      resolve: async (p, origin) => {
        const s = await prisma.skill.findUnique({ where: { id: p.id } }).catch(() => null);
        if (!s || !s.shared) return null;
        return {
          title: s.title || 'Shared skill',
          description: cleanDescription(s.description, 'A skill shared from My Brain.'),
          image: card(origin, 'skill', s.id),
          url: `${origin}/skill/${s.id}`,
        };
      },
    },

    // A shared meeting. Deliberately NO summary text in the description — the card would be cached
    // by every chat app it passes through. The date is enough to recognise it.
    {
      path: '/meeting-view/:id',
      resolve: async (p, origin) => {
        const m = await prisma.meeting.findUnique({ where: { id: p.id } }).catch(() => null);
        if (!m || !m.shared) return null;
        const when = m.createdAt ? new Date(m.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        return {
          title: m.title || 'Shared meeting',
          description: cleanDescription(when ? `Meeting notes · ${when}` : '', 'Meeting notes shared from My Brain.'),
          image: card(origin, 'meeting', m.id),
          url: `${origin}/meeting-view/${m.id}`,
        };
      },
    },

    // A shared bookmark / saved item.
    {
      path: '/view/:id',
      resolve: async (p, origin) => {
        const it = await prisma.item.findUnique({ where: { id: p.id } }).catch(() => null);
        if (!it || !it.shared) return null;
        return {
          title: it.title || 'Shared item',
          description: cleanDescription(it.summary, 'Saved in My Brain.'),
          image: card(origin, 'item', it.id),
          url: `${origin}/view/${it.id}`,
        };
      },
    },
  ];
}

/** Register the preview routes on the express instance. Must run BEFORE the static/SPA fallback. */
export function registerLinkPreviews(
  server: any,
  opts: { pub: string; deps: Deps; origin: (req: Request) => string },
): void {
  let shell: string | null = null;
  const getShell = () => (shell ??= readFileSync(join(opts.pub, 'index.html'), 'utf8'));

  for (const route of buildOgRoutes(opts.deps)) {
    server.get(route.path, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const meta = await route.resolve(req.params as Record<string, string>, opts.origin(req));
        if (!meta) return next(); // not shared / missing → default card
        res.type('html').send(injectOg(getShell(), meta));
      } catch {
        next();
      }
    });
  }
}
