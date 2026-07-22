import { LayoutDashboard, FilePlus2, Bookmark, Lightbulb, Wand2, CheckSquare, Activity, Sun, MessageCircle, StickyNote, Mic, Mail, Sparkles, Lock, FlaskConical, FileText, Bot, Workflow, Users, MessagesSquare, AudioLines, Disc3, type LucideIcon } from 'lucide-react';

export type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };
export type NavGroup = { label?: string; items: NavItem[] };

/**
 * The sidebar, grouped under quiet headers so the eye can skip whole blocks — 24 flat entries had
 * become genuinely confusing (owner, 2026-07-22). Same destinations, calmer shape. Two entries are
 * gone on purpose: Delegated and To review live as tabs inside Tasks now (BEA-1044), and
 * "Reminders" is named what the page actually is — the WhatsApp Chats inbox.
 *
 * Settings is intentionally NOT here — it lives in the top-right account menu (and the mobile drawer).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ to: '/', label: 'Home', icon: LayoutDashboard, end: true }],
  },
  {
    label: 'Daily',
    items: [
      { to: '/today', label: 'Today', icon: Sun },
      { to: '/tasks', label: 'Tasks', icon: CheckSquare },
      { to: '/activity', label: 'Activity', icon: Activity },
    ],
  },
  {
    label: 'People',
    items: [
      { to: '/contacts', label: 'Contacts', icon: Users },
      { to: '/reminders', label: 'Chats', icon: MessagesSquare }, // the WhatsApp inbox (BEA-1044)
    ],
  },
  {
    label: 'Voice & AI',
    items: [
      { to: '/emo', label: 'Emo', icon: AudioLines },
      { to: '/recordings', label: 'Recordings', icon: Disc3 },
      { to: '/explore', label: 'Explore', icon: Sparkles },
      { to: '/chat', label: 'Chat', icon: MessageCircle },
    ],
  },
  {
    label: 'Library',
    items: [
      { to: '/capture', label: 'Capture', icon: FilePlus2 },
      { to: '/documents', label: 'Documents', icon: FileText },
      { to: '/notes', label: 'Notes', icon: StickyNote },
      { to: '/ideas', label: 'Ideas', icon: Lightbulb },
      { to: '/bookmarks', label: 'Bookmarks', icon: Bookmark },
      { to: '/meetings', label: 'Meetings', icon: Mic },
    ],
  },
  {
    label: 'Automation',
    items: [
      { to: '/agent', label: 'Agents', icon: Bot },
      { to: '/flows', label: 'Flows', icon: Workflow },
      { to: '/skills', label: 'Skills', icon: Wand2 },
    ],
  },
  {
    label: 'Other',
    items: [
      { to: '/google', label: 'Google', icon: Mail },
      { to: '/lab', label: 'The Lab', icon: FlaskConical },
      { to: '/vault', label: 'Vault', icon: Lock },
    ],
  },
];

/** Flat list, derived — anything that just needs "every destination" keeps working. */
export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

// The 5 primary tabs shown in the mobile bottom bar. Everything else lives in the drawer/sidebar.
export const BOTTOM_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/today', label: 'Today', icon: Sun },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/ideas', label: 'Ideas', icon: Lightbulb },
];
