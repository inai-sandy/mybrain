import { FilePlus2, Upload, Link2, FileText } from 'lucide-react';
import { PagePlaceholder } from './PagePlaceholder';

export function Capture() {
  return (
    <PagePlaceholder title="Capture" subtitle="Add to your brain three ways." icon={FilePlus2}>
      <div className="grid sm:grid-cols-3 gap-3 max-w-xl mx-auto text-left">
        {[
          { icon: Upload, label: 'Upload markdown' },
          { icon: FileText, label: 'Pull a Notion page' },
          { icon: Link2, label: 'Paste a public link' },
        ].map((d) => (
          <div key={d.label} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 flex items-center gap-2 text-sm">
            <d.icon size={16} className="text-emerald-600" /> {d.label}
          </div>
        ))}
      </div>
    </PagePlaceholder>
  );
}
