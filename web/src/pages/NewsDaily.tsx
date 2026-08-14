import { Navigate, useSearchParams } from 'react-router-dom';
import { RadarView } from './RadarView';
import { NewsShell, NewsToggle } from './NewsShell';

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
      <RadarView />
    </NewsShell>
  );
}
