import { LayoutDashboard, FilePlus2, Bookmark, Lightbulb, Wand2, CheckSquare, Activity, Sun, MessageCircle, type LucideIcon } from 'lucide-react';

export type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

// Settings is intentionally NOT here — it lives in the top-right account menu (and the mobile drawer).
export const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/capture', label: 'Capture', icon: FilePlus2 },
  { to: '/bookmarks', label: 'Bookmarks', icon: Bookmark },
  { to: '/ideas', label: 'Ideas', icon: Lightbulb },
  { to: '/skills', label: 'Skills', icon: Wand2 },
  { to: '/today', label: 'Today', icon: Sun },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/chat', label: 'Chat', icon: MessageCircle },
  { to: '/activity', label: 'Activity', icon: Activity },
];

// The 5 primary tabs shown in the mobile bottom bar. Everything else lives in the drawer/sidebar.
export const BOTTOM_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/ideas', label: 'Ideas', icon: Lightbulb },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/today', label: 'Today', icon: Sun },
];
