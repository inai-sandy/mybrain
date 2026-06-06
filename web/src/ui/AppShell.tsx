import { ReactNode } from 'react';
import { useTheme } from './theme';

const NAV = [
  { label: 'Home', href: '#' },
  { label: 'Capture', href: '#' },
  { label: 'Tasks', href: '#' },
  { label: 'Search', href: '#' },
];

export function AppShell({
  email,
  onSignOut,
  children,
}: {
  email?: string;
  onSignOut?: () => void;
  children: ReactNode;
}) {
  const { theme, toggle } = useTheme();
  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="sticky top-0 z-20 flex items-center justify-between gap-4 px-4 sm:px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur">
        <div className="flex items-center gap-2 font-bold">
          <span className="text-xl">🧠</span>
          <span>My Brain</span>
        </div>
        <nav className="hidden sm:flex gap-5 text-sm text-zinc-500 dark:text-zinc-400">
          {NAV.map((n) => (
            <a key={n.label} href={n.href} className="hover:text-zinc-900 dark:hover:text-white transition-colors">
              {n.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            aria-label="Toggle dark mode"
            onClick={toggle}
            className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-sm"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          {email && <span className="hidden md:inline text-sm text-zinc-400">{email}</span>}
          {onSignOut && (
            <button
              onClick={onSignOut}
              className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Sign out
            </button>
          )}
        </div>
      </header>
      <main className="max-w-4xl mx-auto p-4 sm:p-6">{children}</main>
    </div>
  );
}
