import { LayoutDashboard, FilePlus2, Bookmark, Lightbulb, Wand2, CheckSquare, Activity, Sun, MessageCircle, StickyNote, Mic, Mail, Sparkles, Handshake, Lock, FlaskConical, type LucideIcon } from 'lucide-react';

export type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

// Settings is intentionally NOT here — it lives in the top-right account menu (and the mobile drawer).
export const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/explore', label: 'Explore', icon: Sparkles },
  { to: '/capture', label: 'Capture', icon: FilePlus2 },
  { to: '/bookmarks', label: 'Bookmarks', icon: Bookmark },
  { to: '/ideas', label: 'Ideas', icon: Lightbulb },
  { to: '/skills', label: 'Skills', icon: Wand2 },
  // Daily-flow cluster, in one order (BEA-440)
  { to: '/today', label: 'Today', icon: Sun },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/lab', label: 'The Lab', icon: FlaskConical },
  { to: '/commitments', label: 'Commitments', icon: Handshake },
  { to: '/meetings', label: 'Meetings', icon: Mic },
  { to: '/google', label: 'Google', icon: Mail },
  { to: '/notes', label: 'Notes', icon: StickyNote },
  { to: '/vault', label: 'Vault', icon: Lock },
  { to: '/chat', label: 'Chat', icon: MessageCircle },
];

// The 5 primary tabs shown in the mobile bottom bar. Everything else lives in the drawer/sidebar.
export const BOTTOM_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/today', label: 'Today', icon: Sun },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/ideas', label: 'Ideas', icon: Lightbulb },
];
