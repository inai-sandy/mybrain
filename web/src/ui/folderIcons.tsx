import {
  Folder, Briefcase, Star, Heart, BookOpen, Code2, Image, FileText, Music, Film,
  Camera, Globe, Lightbulb, Rocket, Flag, Wallet, GraduationCap, Coffee, Home,
  Building2, ShoppingCart, Plane, Palette, Wrench, type LucideIcon,
} from 'lucide-react';

/** Curated folder-icon set (stored by name on the collection). (BEA-588) */
export const FOLDER_ICONS: Record<string, LucideIcon> = {
  Folder, Briefcase, Star, Heart, BookOpen, Code2, Image, FileText, Music, Film,
  Camera, Globe, Lightbulb, Rocket, Flag, Wallet, GraduationCap, Coffee, Home,
  Building2, ShoppingCart, Plane, Palette, Wrench,
};

export const FOLDER_ICON_NAMES = Object.keys(FOLDER_ICONS);
export const DEFAULT_FOLDER_ICON = 'Folder';

export function FolderGlyph({ name, size = 22, className }: { name?: string | null; size?: number; className?: string }) {
  const Icon = (name && FOLDER_ICONS[name]) || Folder;
  return <Icon size={size} className={className} />;
}
