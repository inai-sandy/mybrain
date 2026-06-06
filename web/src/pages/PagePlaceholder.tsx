import { ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';

export function PagePlaceholder({
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">{title}</h1>
        <p className="text-zinc-500">{subtitle}</p>
      </div>
      <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-white/50 dark:bg-zinc-900/40 p-10 text-center">
        <Icon size={32} className="mx-auto mb-3 text-zinc-400" />
        <p className="text-zinc-500">Coming soon — this is next on the build list.</p>
        {children && <div className="mt-4">{children}</div>}
      </div>
    </div>
  );
}
