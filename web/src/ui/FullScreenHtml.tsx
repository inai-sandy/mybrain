import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * Renders an HTML document full-screen and *alive* — like a tiiny.host page. (BEA-582)
 * The iframe gets `allow-scripts` so Tailwind/Chart.js/interactive pages actually run,
 * but NOT `allow-same-origin`, so the page lives in an isolated origin that cannot reach
 * the app, its cookies, or the user's login.
 */
export function FullScreenHtml({ html, title, backTo }: { html: string; title: string; backTo?: string }) {
  return (
    <div className="fixed inset-0 bg-white">
      <iframe
        title={title}
        srcDoc={html}
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
      />
      {backTo && (
        <Link
          to={backTo}
          title="Back"
          className="fixed left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white backdrop-blur hover:bg-black/85"
        >
          <ArrowLeft size={14} /> Back
        </Link>
      )}
      <a
        href="https://mybrain.1site.ai"
        target="_blank"
        rel="noreferrer"
        className="fixed bottom-3 right-3 z-10 rounded-full bg-black/70 px-3 py-1.5 text-[11px] font-medium text-white/90 backdrop-blur hover:bg-black/85"
      >
        · My Brain ·
      </a>
    </div>
  );
}
