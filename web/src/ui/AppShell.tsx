import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Logo } from './Logo';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LogOut, Moon, Sun, Menu, X, Settings as SettingsIcon, UserCircle, HelpCircle, FileText, ExternalLink, MessageCircle, Search, RefreshCw, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NAV_GROUPS } from './nav';
import { HELP_DOCS } from './help';
import { InstallPrompt } from './InstallPrompt';
import { DictationIndicator } from './DictationIndicator';
import { forceUpdate } from './forceUpdate';
import { SearchOverlay, openSearch } from './SearchOverlay';
import { useEdgeSwipeBack } from './useSwipeBack';
import { ScrollMemory } from './ScrollMemory';
import { useTheme } from './theme';

/** Keep --vvh synced to the visible viewport height (shrinks when the keyboard opens) and report
 *  whether the on-screen keyboard is up. When `pin`, hold the window at the top so iOS can't scroll
 *  the page up to chase a focused input. */
function useVisualViewport(pin: boolean): boolean {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let lastH = -1;
    const update = () => {
      const h = Math.round(vv.height);
      if (h !== lastH) {
        document.documentElement.style.setProperty('--vvh', `${h}px`); // only write when it actually changes
        lastH = h;
      }
      const open = window.innerHeight - vv.height > 120;
      setKeyboardOpen(open);
      if (pin && open) window.scrollTo(0, 0);
    };
    update();
    // Only 'resize' (keyboard show/hide). NOT 'scroll' — that fires every frame while scrolling and thrashed style.
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, [pin]);
  return keyboardOpen;
}

export function AppShell({ email, onSignOut }: { email?: string; onSignOut?: () => void }) {
  const { theme, toggle } = useTheme();
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const isChat = location.pathname === '/chat';
  useVisualViewport(isChat); // keeps --vvh synced (used by the chat height calc) + pins iOS on focus
  // Left-edge swipe-back for the installed app (disabled while the mobile drawer is open). (BEA-593)
  // The content column slides under the finger as you drag (BEA-1002).
  const slideRef = useRef<HTMLDivElement>(null);
  useEdgeSwipeBack(!drawer, slideRef);
  // Desktop sidebar collapse (icon-only rail), remembered per device. (BEA-440)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar.collapsed') === '1');
  useEffect(() => { localStorage.setItem('sidebar.collapsed', collapsed ? '1' : '0'); }, [collapsed]);

  // Agents nav badge: how many agent questions are waiting on you. Polled gently; refreshed on
  // every route change so answering a card clears it right away. (BEA-1066)
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    const load = () => fetch('/api/agent/waiting-count').then((r) => r.json()).then((d) => setWaiting(d?.count || 0)).catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [location.pathname]);
  const navBadge = (to: string) =>
    to === '/agent' && waiting > 0 ? (
      <span className="ml-auto rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">{waiting}</span>
    ) : null;

  const itemCls = ({ isActive }: { isActive: boolean }) =>
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
    (isActive ? 'bg-emerald-600 text-white' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800');
  // Desktop sidebar item — centers the icon and drops the label when collapsed.
  const deskItemCls = ({ isActive }: { isActive: boolean }) =>
    'flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors ' +
    (collapsed ? 'justify-center px-0 ' : 'px-3 ') +
    (isActive ? 'bg-emerald-600 text-white' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800');

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* App-wide scroll save/restore so Back returns you to where you were (BEA-1001) */}
      <ScrollMemory />
      {/* Desktop sidebar (collapsible to an icon-only rail) */}
      <aside className={'hidden md:flex md:flex-col md:fixed md:inset-y-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-4 transition-all duration-200 ' + (collapsed ? 'md:w-16' : 'md:w-60')}>
        <div className={'flex items-center gap-2 mb-6 font-bold text-lg ' + (collapsed ? 'justify-center px-0' : 'px-2')}>
          <Logo size={collapsed ? 30 : 34} /> {!collapsed && 'My Brain'}
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-1">
          {/* Grouped under quiet headers so the eye can skip whole blocks. (BEA-1044) */}
          {NAV_GROUPS.map((g, gi) => (
            <div key={g.label || gi} className={gi > 0 ? 'pt-2' : ''}>
              {g.label && !collapsed && (
                <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{g.label}</div>
              )}
              {g.label && collapsed && <div className="mx-3 my-1.5 border-t border-zinc-100 dark:border-zinc-800" />}
              {g.items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} title={collapsed ? n.label : undefined} className={deskItemCls}>
                  <span className="relative">
                    <n.icon size={18} />
                    {collapsed && n.to === '/agent' && waiting > 0 && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-amber-500" />}
                  </span>
                  {!collapsed && n.label}
                  {!collapsed && navBadge(n.to)}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={'mt-2 flex items-center gap-3 rounded-lg py-2 text-sm font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors ' + (collapsed ? 'justify-center px-0' : 'px-3')}
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <><PanelLeftClose size={18} /> Collapse</>}
        </button>
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="md:hidden fixed inset-0 z-40" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 px-3 py-4 flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-2 mb-6">
              <div className="flex items-center gap-2 font-bold text-lg">
                <Logo size={34} /> My Brain
              </div>
              <button onClick={() => setDrawer(false)} aria-label="Close menu" className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                <X size={20} />
              </button>
            </div>
            <nav className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-1">
              {NAV_GROUPS.map((g, gi) => (
                <div key={g.label || gi} className={gi > 0 ? 'pt-2' : ''}>
                  {g.label && <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{g.label}</div>}
                  {g.items.map((n) => (
                    <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setDrawer(false)} className={itemCls}>
                      <n.icon size={18} /> {n.label}
                      {navBadge(n.to)}
                    </NavLink>
                  ))}
                </div>
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
      <div ref={slideRef} className={'transition-all duration-200 ' + (collapsed ? 'md:pl-16' : 'md:pl-60')}>
        <header className="sticky top-0 z-20 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 md:bg-white/80 md:dark:bg-zinc-950/80 md:backdrop-blur" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
          <div className="flex items-center justify-between gap-3 px-4 sm:px-6 h-14">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={() => setDrawer(true)} aria-label="Menu" className="md:hidden p-2 -ml-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <Menu size={20} />
            </button>
            <div className="md:hidden flex items-center gap-2 font-bold">
              <Logo size={30} /> My Brain
            </div>
            <button
              onClick={openSearch}
              className="hidden md:flex items-center gap-2 flex-1 max-w-md rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:border-emerald-500/50"
            >
              <Search size={15} /> <span>Search your brain…</span>
              <kbd className="ml-auto hidden lg:inline text-[10px] rounded border border-zinc-300 dark:border-zinc-600 px-1 py-0.5">⌘K</kbd>
            </button>
          </div>

          <div className="flex items-center gap-1 shrink-0">
          {/* Mobile search */}
          <button onClick={openSearch} aria-label="Search" className="md:hidden p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500">
            <Search size={20} />
          </button>
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
                  <button onClick={() => forceUpdate()} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    <RefreshCw size={16} /> Force update
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
          </div>
        </header>

        <main
          className={
            isChat
              ? 'h-[calc(var(--vvh)-3.5rem-env(safe-area-inset-top))] md:h-[calc(var(--vvh)-3.5rem-env(safe-area-inset-top))] overflow-hidden'
              : 'p-4 sm:p-6 pb-20 md:pb-8 max-w-4xl mx-auto'
          }
        >
          {isChat ? (
            <Outlet />
          ) : (
            // A quick opacity-only fade — no y-slide, which felt jumpy and fought scroll restoration (BEA-1002).
            <motion.div key={location.pathname} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.14, ease: 'easeOut' }}>
              <Outlet />
            </motion.div>
          )}
        </main>
      </div>

      {/* Global search overlay (find + ask) */}
      <SearchOverlay />

      {/* Install-this-app banner (Android button / iOS hint) */}
      <InstallPrompt />

      {/* Live voice-dictation banner — shows what's being heard + a Stop button, globally */}
      <DictationIndicator />

      {/* Floating "chat with your brain" button — every page except the chat itself. No bottom tab bar
          anymore (BEA-489), so it sits just above the bottom safe area. */}
      {!isChat && (
        <button
          onClick={() => navigate('/chat')}
          title="Chat with your brain"
          aria-label="Chat with your brain"
          className="fixed right-4 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] md:bottom-6 z-40 inline-flex items-center justify-center rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 h-12 w-12"
        >
          <MessageCircle size={22} />
        </button>
      )}
    </div>
  );
}
