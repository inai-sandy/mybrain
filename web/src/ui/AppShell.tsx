import { useState } from 'react';
import { Logo } from './Logo';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LogOut, Moon, Sun, Menu, X, Settings as SettingsIcon, UserCircle, HelpCircle, FileText, ExternalLink, MessageCircle } from 'lucide-react';
import { NAV, BOTTOM_NAV } from './nav';
import { HELP_DOCS } from './help';
import { InstallPrompt } from './InstallPrompt';
import { useTheme } from './theme';

export function AppShell({ email, onSignOut }: { email?: string; onSignOut?: () => void }) {
  const { theme, toggle } = useTheme();
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const navigate = useNavigate();
  const isChat = useLocation().pathname === '/chat';

  const itemCls = ({ isActive }: { isActive: boolean }) =>
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
    (isActive ? 'bg-emerald-600 text-white' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800');

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:flex-col md:fixed md:inset-y-0 md:w-60 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-4">
        <div className="flex items-center gap-2 px-2 mb-6 font-bold text-lg">
          <Logo size={28} /> My Brain
        </div>
        <nav className="flex-1 space-y-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={itemCls}>
              <n.icon size={18} /> {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="md:hidden fixed inset-0 z-40" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 px-3 py-4 flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-2 mb-6">
              <div className="flex items-center gap-2 font-bold text-lg">
                <Logo size={28} /> My Brain
              </div>
              <button onClick={() => setDrawer(false)} aria-label="Close menu" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                <X size={20} />
              </button>
            </div>
            <nav className="flex-1 space-y-1">
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setDrawer(false)} className={itemCls}>
                  <n.icon size={18} /> {n.label}
                </NavLink>
              ))}
              <NavLink to="/settings" onClick={() => setDrawer(false)} className={itemCls}>
                <SettingsIcon size={18} /> Settings
              </NavLink>
              <div className="pt-3 mt-2 border-t border-zinc-100 dark:border-zinc-800">
                <div className="px-3 pb-1 text-xs text-zinc-400">Help</div>
                {HELP_DOCS.map((d) => (
                  <a key={d.href} href={d.href} target="_blank" rel="noopener noreferrer" onClick={() => setDrawer(false)} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    <HelpCircle size={18} /> {d.title}
                  </a>
                ))}
              </div>
            </nav>
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="md:pl-60">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 px-4 sm:px-6 h-14 border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={() => setDrawer(true)} aria-label="Menu" className="md:hidden p-2 -ml-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <Menu size={20} />
            </button>
            <div className="md:hidden flex items-center gap-2 font-bold">
              <Logo size={24} /> My Brain
            </div>
            <div className="hidden md:block flex-1 max-w-md">
              <input
                aria-label="Search"
                placeholder="Search your brain…"
                className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
          {/* Help / support menu */}
          <div className="relative">
            <button onClick={() => setHelp((h) => !h)} aria-label="Help" className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <HelpCircle size={22} className="text-zinc-500" />
              <span className="hidden sm:inline text-sm text-zinc-500">Help</span>
            </button>
            {help && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setHelp(false)} />
                <div className="absolute right-0 mt-2 w-60 z-40 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg p-1.5">
                  <div className="px-3 py-2 text-xs text-zinc-400 border-b border-zinc-100 dark:border-zinc-800 mb-1">Guides &amp; help</div>
                  {HELP_DOCS.map((d) => (
                    <a key={d.href} href={d.href} target="_blank" rel="noopener noreferrer" onClick={() => setHelp(false)} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                      <FileText size={16} className="text-zinc-400 shrink-0" />
                      <span className="flex-1 truncate">{d.title}</span>
                      <ExternalLink size={13} className="text-zinc-400 shrink-0" />
                    </a>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Account & settings menu */}
          <div className="relative">
            <button onClick={() => setMenu((m) => !m)} aria-label="Account menu" className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <UserCircle size={22} className="text-zinc-500" />
              <span className="hidden sm:inline text-sm text-zinc-500">Settings</span>
            </button>
            {menu && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
                <div className="absolute right-0 mt-2 w-56 z-40 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg p-1.5">
                  {email && <div className="px-3 py-2 text-xs text-zinc-400 truncate border-b border-zinc-100 dark:border-zinc-800 mb-1">{email}</div>}
                  <button onClick={toggle} aria-label="Toggle dark mode" className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />} {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                  </button>
                  <button onClick={() => { setMenu(false); navigate('/settings'); }} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    <SettingsIcon size={16} /> Settings
                  </button>
                  {onSignOut && (
                    <button onClick={() => { setMenu(false); onSignOut(); }} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                      <LogOut size={16} /> Sign out
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          </div>
        </header>

        <main className={isChat ? 'h-[calc(100vh-7rem)] md:h-[calc(100vh-3.5rem)] overflow-hidden' : 'p-4 sm:p-6 pb-24 md:pb-8 max-w-4xl mx-auto'}>
          <Outlet />
        </main>
      </div>

      {/* Install-this-app banner (Android button / iOS hint) */}
      <InstallPrompt />

      {/* Floating "chat with your brain" button — every page except the chat itself */}
      {!isChat && (
        <button
          onClick={() => navigate('/chat')}
          title="Chat with your brain"
          aria-label="Chat with your brain"
          className="fixed right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] md:bottom-6 z-40 inline-flex items-center justify-center rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 h-12 w-12"
        >
          <MessageCircle size={22} />
        </button>
      )}

      {/* Bottom tab bar — mobile (5 primary tabs; the rest are in the drawer) */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-30 grid border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
        style={{ gridTemplateColumns: `repeat(${BOTTOM_NAV.length}, minmax(0, 1fr))`, paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {BOTTOM_NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              'flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] ' + (isActive ? 'text-emerald-600' : 'text-zinc-500 dark:text-zinc-400')
            }
          >
            <n.icon size={20} /> {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
