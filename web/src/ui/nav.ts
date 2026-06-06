import { LayoutDashboard, FilePlus2, CheckSquare, Search, Settings, type LucideIcon } from 'lucide-react';

export type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

export const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/capture', label: 'Capture', icon: FilePlus2 },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/find', label: 'Find', icon: Search },
  { to: '/settings', label: 'Settings', icon: Settings },
];
