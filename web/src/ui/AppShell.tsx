import { NavLink, Outlet } from 'react-router-dom';
import { LogOut, Moon, Sun } from 'lucide-react';
import { NAV } from './nav';
import { useTheme } from './theme';

export function AppShell({ email, onSignOut }: { email?: string; onSignOut?: () => void }) {
  const { theme, toggle } = useTheme();

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Sidebar — desktop */}
      <aside className="hidden md:flex md:flex-col md:fixed md:inset-y-0 md:w-60 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-4">
        <div className="flex items-center gap-2 px-2 mb-6 font-bold text-lg">
          <span className="text-2xl">🧠</span> My Brain
        </div>
        <nav className="flex-1 space-y-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
                (isActive
                  ? 'bg-emerald-600 text-white'
                  : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800')
              }
            >
              <n.icon size={18} /> {n.label}
            </NavLink>
          ))}
        </nav>
        {onSignOut && (
          <button
            onClick={onSignOut}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <LogOut size={18} /> Sign out
          </button>
        )}
      </aside>

      {/* Main column */}
      <div className="md:pl-60">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 px-4 sm:px-6 h-14 border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur">
          <div className="md:hidden flex items-center gap-2 font-bold">
            <span className="text-xl">🧠</span> My Brain
          </div>
          <div className="hidden md:block flex-1 max-w-md">
            <input
              aria-label="Search"
              placeholder="Search your brain…"
              className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              aria-label="Toggle dark mode"
              onClick={toggle}
              className="rounded-lg p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            {email && <span className="hidden sm:inline text-sm text-zinc-400">{email}</span>}
          </div>
        </header>

        <main className="p-4 sm:p-6 pb-24 md:pb-8 max-w-4xl mx-auto">
          <Outlet />
        </main>
      </div>

      {/* Bottom tab bar — mobile */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-30 grid border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
        style={{ gridTemplateColumns: `repeat(${NAV.length}, minmax(0, 1fr))` }}
      >
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              'flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] ' +
              (isActive ? 'text-emerald-600' : 'text-zinc-500 dark:text-zinc-400')
            }
          >
            <n.icon size={20} /> {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
