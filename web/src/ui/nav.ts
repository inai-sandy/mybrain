import { LayoutDashboard, FilePlus2, Bookmark, Lightbulb, Wand2, CheckSquare, type LucideIcon } from 'lucide-react';

export type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

// Settings is intentionally NOT here — it lives in the top-right account menu (and the mobile drawer).
export const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/capture', label: 'Capture', icon: FilePlus2 },
  { to: '/bookmarks', label: 'Bookmarks', icon: Bookmark },
  { to: '/ideas', label: 'Ideas', icon: Lightbulb },
  { to: '/skills', label: 'Skills', icon: Wand2 },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
];
