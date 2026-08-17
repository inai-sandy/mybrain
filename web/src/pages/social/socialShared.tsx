import { ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Coins, Gauge, KeyRound, RefreshCw, Wallet } from 'lucide-react';
import { Skeleton } from '../../ui/Skeleton';

/**
 * Shared pieces of the Social section (BEA-1356) — the grid (`Social.tsx`) and the platform page
 * (`SocialPlatform.tsx`) draw the same header strip, the same logo tile and the same notices.
 * Design: `specs/SOCIAL.md`. Everything reads `/api/social*`; no vendor name appears in a route.
 */

export type Platform = {
  slug: string;
  name: string;
  actionCount: number;
  tags: string[];
  kinds: string[];
  description?: string;
  connected: boolean;
};

export type SocialStatus = { configured: boolean; reachable: boolean; message?: string };

export type Overview = {
  status: SocialStatus;
  balance: number | null;
  spentToday: number;
  ceiling: number | null;
  platforms: Platform[];
  spec: { source: string; generatedAt?: string; opCount: number; platformCount: number; lastError?: string };
  topUpUrl: string;
};

export type Spend = { status: SocialStatus; balance: number | null; spentToday: number; ceiling: number | null; topUpUrl: string };

/** One endpoint, exactly as the provider generated it from the spec. */
export type Endpoint = {
  id: string;
  name: string;
  description: string;
  schema: { type?: string; properties?: Record<string, any>; required?: string[] };
  service: string;
  method?: string;
  path?: string;
  tags?: string[];
  costHint?: string;
  deprecated?: boolean;
};

export type RunResult = {
  ok: boolean;
  data?: any;
  error?: string;
  credits?: number;
  ms?: number;
  outOfCredits?: boolean;
  topUpUrl?: string;
  actionName?: string;
};

export const num = (n: number | undefined | null) => (Number.isFinite(n as number) ? Number(n) : 0);
export const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const PRIMARY_BTN = 'inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50';
export const GHOST_BTN = 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3.5 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50';
export const CHIP = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap';
export const INPUT = 'w-full min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500';

// ---- logos ------------------------------------------------------------------------------------

/**
 * Brand marks, by slug. The list is a UI convenience only — the PLATFORMS come from the provider,
 * and a platform not in this map still gets a tile (its initial), so a new platform on their side
 * appears here on day one. Simple Icons is a CDN of brand marks in one style; a colour is chosen
 * per brand so the grid reads at a glance. Anything that fails to load falls back to the initial.
 */
const MARKS: Record<string, { icon: string; color: string }> = {
  tiktok: { icon: 'tiktok', color: '000000' },
  instagram: { icon: 'instagram', color: 'E4405F' },
  youtube: { icon: 'youtube', color: 'FF0000' },
  facebook: { icon: 'facebook', color: '0866FF' },
  github: { icon: 'github', color: '181717' },
  linkedin: { icon: 'linkedin', color: '0A66C2' },
  reddit: { icon: 'reddit', color: 'FF4500' },
  twitter: { icon: 'x', color: '000000' },
  spotify: { icon: 'spotify', color: '1DB954' },
  rumble: { icon: 'rumble', color: '85C742' },
  threads: { icon: 'threads', color: '000000' },
  google: { icon: 'google', color: '4285F4' },
  pinterest: { icon: 'pinterest', color: 'BD081C' },
  twitch: { icon: 'twitch', color: '9146FF' },
  apple_music: { icon: 'applemusic', color: 'FA243C' },
  truthsocial: { icon: 'truthsocial', color: '5448EE' },
  bluesky: { icon: 'bluesky', color: '0285FF' },
  soundcloud: { icon: 'soundcloud', color: 'FF5500' },
  kwai: { icon: 'kuaishou', color: 'FF4906' },
  snapchat: { icon: 'snapchat', color: 'FFFC00' },
  kick: { icon: 'kick', color: '53FC18' },
  linktree: { icon: 'linktree', color: '43E55E' },
  amazon: { icon: 'amazon', color: 'FF9900' },
};

/** The brand mark's URL, or null when we have none for this slug (the tile then shows an initial). */
export function markUrl(slug: string): string | null {
  const m = MARKS[slug];
  return m ? `https://cdn.simpleicons.org/${m.icon}/${m.color}` : null;
}

/**
 * The platform's tile. Light in dark mode on purpose (brand marks are drawn for white — TikTok,
 * GitHub and Threads are near-black and vanish on a dark tile). A missing or broken mark is an
 * initial, never a broken-image icon.
 */
export function PlatformLogo({ p, size = 40 }: { p: Pick<Platform, 'slug' | 'name'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = markUrl(p.slug);
  return (
    <div
      className="shrink-0 grid place-items-center overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-100"
      style={{ width: size, height: size }}
      data-testid="platform-logo"
    >
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} className="object-contain" style={{ width: size * 0.5, height: size * 0.5 }} />
      ) : (
        <span className="font-bold text-zinc-400" style={{ fontSize: size * 0.42 }}>
          {(p.name || p.slug).charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}

// ---- the credits strip -----------------------------------------------------------------------

/**
 * Balance · today's spend · the daily ceiling. The ceiling is read-only here (BEA-1358 adds the
 * setting); until it is set the tile says so in words rather than showing a dash.
 */
export function CreditStrip({ balance, spentToday, ceiling, status, compact = false, loading = false }: { balance: number | null; spentToday: number; ceiling: number | null; status?: SocialStatus; compact?: boolean; loading?: boolean }) {
  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-2 sm:gap-3" data-testid="credits-loading">
        {[0, 1, 2].map((i) => <Skeleton key={i} className={compact ? 'h-12' : 'h-[4.5rem]'} />)}
      </div>
    );
  }
  const noKey = status && !status.configured;
  const unreachable = status && status.configured && !status.reachable;
  const pad = compact ? 'px-3 py-2' : 'p-3 sm:p-4';
  const big = compact ? 'text-base' : 'text-lg sm:text-2xl';
  const tile = 'min-w-0 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 ' + pad;
  const label = 'flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400';
  const over = ceiling !== null && spentToday >= ceiling;
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-3" data-testid="credit-strip">
      <div className={tile}>
        <div className={label}><Wallet size={12} /> Credits left</div>
        <div className={big + ' mt-0.5 font-bold tabular-nums truncate'} data-testid="credit-balance">
          {noKey ? <span className="text-sm font-medium text-zinc-400">No key</span> : balance === null ? <span className="text-sm font-medium text-zinc-400">{unreachable ? 'Unreachable' : '—'}</span> : balance.toLocaleString()}
        </div>
      </div>
      <div className={tile}>
        <div className={label}><Coins size={12} /> Spent today</div>
        <div className={big + ' mt-0.5 font-bold tabular-nums truncate ' + (over ? 'text-amber-600 dark:text-amber-400' : '')} data-testid="credit-spent">{num(spentToday).toLocaleString()}</div>
      </div>
      <div className={tile}>
        <div className={label}><Gauge size={12} /> Daily ceiling</div>
        <div className={big + ' mt-0.5 font-bold tabular-nums truncate'} data-testid="credit-ceiling">
          {ceiling === null ? <span className="text-sm font-medium text-zinc-400">No limit set</span> : ceiling.toLocaleString()}
        </div>
      </div>
    </div>
  );
}

// ---- notices ------------------------------------------------------------------------------------

/** One calm box for every "there is nothing to show, and here is why" moment in Social. */
export function Notice({ icon, title, body, action, tone = 'plain' }: { icon: ReactNode; title: string; body: ReactNode; action?: ReactNode; tone?: 'plain' | 'warn' }) {
  const warn = tone === 'warn';
  return (
    <div className={'rounded-xl border p-4 sm:p-5 ' + (warn ? 'border-amber-300/60 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5' : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900')} role={warn ? 'alert' : undefined}>
      <div className="flex flex-col items-start gap-3 sm:flex-row">
        <div className={'shrink-0 rounded-lg p-2 ' + (warn ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-emerald-500/10 text-emerald-600')}>{icon}</div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{title}</h3>
          <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400 break-words">{body}</div>
          {action && <div className="mt-3 flex flex-wrap gap-2">{action}</div>}
        </div>
      </div>
    </div>
  );
}

/** No key: the one state that is not an error. Said the same way on both screens. */
export function NoKeyNotice() {
  return (
    <Notice
      icon={<KeyRound size={20} />}
      title="No Scrape Creators key yet"
      body="Social runs on one key that you add once in Settings. You can browse every platform below, but nothing can run until the key is in."
      action={<Link to="/settings/connections" className={PRIMARY_BTN}>Add the key in Settings <ArrowRight size={15} /></Link>}
    />
  );
}

/** The spec could not be read just now: the last good list is on screen, and the page says so. */
export function SpecNotice({ spec, onRetry }: { spec: Overview['spec']; onRetry?: () => void }) {
  // Gated on the error alone: after one good live read the source stays 'live' for ever, so the
  // source cannot say "stale" — the last error can.
  if (!spec?.lastError) return null;
  const when = spec.generatedAt ? new Date(spec.generatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <Notice
      tone="warn"
      icon={<AlertTriangle size={20} />}
      title="Showing the last good list"
      body={`Their endpoint list could not be read just now (${spec.lastError}). What you see is the last copy we kept${when ? `, from ${when}` : ''} — ${plural(spec.opCount, 'endpoint')} across ${plural(spec.platformCount, 'platform')}.`}
      action={onRetry && <button onClick={onRetry} className={GHOST_BTN}><RefreshCw size={15} /> Try again</button>}
    />
  );
}
