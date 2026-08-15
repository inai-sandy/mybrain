import { Navigate, useSearchParams } from 'react-router-dom';
import { RadarView } from './RadarView';
import { NewsShell, NewsToggle } from './NewsShell';
import { ShareButton } from '../ui/ShareButton';

/**
 * AI News Daily (BEA-1321) — the radar feed as its own page at /news, with its own
 * sidebar entry. The written edition lives on its own page too (/news/tweets); legacy
 * ?view=twitter links from the one-page era land there instead of breaking.
 */
export default function NewsDaily() {
  const [searchParams] = useSearchParams();
  if (searchParams.get('view') === 'twitter') return <Navigate to="/news/tweets" replace />;
  return (
    <NewsShell>
      <NewsToggle active="daily" title="AI News Daily" />
      {/* Shares the PUBLIC page (BEA-1330) — the private /news URL is a login screen
          for anyone else, same rule the paper page follows. */}
      <div className="-mt-1 mb-3 flex justify-end">
        <ShareButton
          url="/radar"
          title="AI News Daily — My Brain"
          text="AI news from around the world, refreshed every hour."
          label="Share public link"
        />
      </div>
      <RadarView />
    </NewsShell>
  );
}
