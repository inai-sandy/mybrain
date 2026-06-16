/**
 * On-brand Google product logos as clean inline SVGs (48×48 viewBox).
 * Geometric, brand-coloured renditions — recognisable per product, no external assets.
 * Each is a function component taking an optional size (px) + className.
 */
type LogoProps = { size?: number; className?: string };
const box = (size: number, className?: string) => ({ width: size, height: size, viewBox: '0 0 48 48', className, xmlns: 'http://www.w3.org/2000/svg' });

export function GmailLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <rect x="3" y="9" width="42" height="30" rx="4" fill="#fff" stroke="#e6e6e6" />
      <path d="M6 13v23a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2z" fill="#4285F4" />
      <path d="M42 13v23a2 2 0 0 0 2-2V13a2 2 0 0 0-2-2z" fill="#34A853" />
      <path d="M6 11l18 13L42 11v4L24 28 6 15z" fill="#EA4335" />
      <path d="M4 13l20 14V39H6a2 2 0 0 1-2-2z" fill="#fff" />
      <path d="M44 13L24 27v12h18a2 2 0 0 0 2-2z" fill="#fff" />
      <path d="M4 13l2-2 18 13 18-13 2 2-20 15z" fill="#EA4335" />
      <path d="M4 13v3l20 14V27z" fill="#C5221F" opacity=".25" />
      <path d="M44 13v3L24 30v-3z" fill="#C5221F" opacity=".25" />
    </svg>
  );
}

export function DriveLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <path d="M16.5 6h15l13.5 23.5h-15z" fill="#FFCF63" />
      <path d="M3 41.5L10.5 29h27L30 41.5z" fill="#11A861" />
      <path d="M3 41.5L16.5 18l7.5 13-7.5 13z" fill="#4285F4" transform="translate(0 -6)" />
      <path d="M16.5 6L3 29.5 10.5 42 24 18.5z" fill="#2684FC" />
      <path d="M31.5 6h-15L24 19l7.5-13z" fill="#00AC47" opacity="0" />
    </svg>
  );
}

export function DocsLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <path d="M12 4h16l8 8v30a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#4285F4" />
      <path d="M28 4l8 8h-8z" fill="#A1C2FA" />
      <rect x="16" y="20" width="16" height="2.4" rx="1.2" fill="#fff" />
      <rect x="16" y="25" width="16" height="2.4" rx="1.2" fill="#fff" />
      <rect x="16" y="30" width="11" height="2.4" rx="1.2" fill="#fff" />
    </svg>
  );
}

export function SheetsLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <path d="M12 4h16l8 8v30a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#0F9D58" />
      <path d="M28 4l8 8h-8z" fill="#A0D6B9" />
      <path d="M16 21h16v13H16zm2 2v3h5v-3zm7 0v3h5v-3zm-7 5v3h5v-3zm7 0v3h5v-3z" fill="#fff" />
    </svg>
  );
}

export function SlidesLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <path d="M12 4h16l8 8v30a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#F4B400" />
      <path d="M28 4l8 8h-8z" fill="#FADA80" />
      <rect x="16" y="22" width="16" height="11" rx="1.5" fill="#fff" />
    </svg>
  );
}

export function CalendarLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <rect x="8" y="8" width="32" height="32" rx="3" fill="#fff" stroke="#E0E0E0" />
      <path d="M8 11a3 3 0 0 1 3-3h26a3 3 0 0 1 3 3v5H8z" fill="#4285F4" />
      <text x="24" y="33" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="15" fill="#4285F4">31</text>
    </svg>
  );
}

export function TasksLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <circle cx="24" cy="24" r="18" fill="#1A73E8" />
      <path d="M16 24.5l5 5 11-12" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MeetLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <path d="M30 18v12l8 6V12z" fill="#00AC47" />
      <rect x="6" y="15" width="26" height="18" rx="3" fill="#2684FC" />
      <path d="M6 24h8l-8 8z" fill="#0066DA" opacity=".0" />
      <rect x="6" y="15" width="9" height="18" fill="#0066DA" />
      <path d="M32 21l6-4.5V12l-8 6z" fill="#00832D" />
      <path d="M32 27v3l6 6v-4.5z" fill="#00AC47" />
      <rect x="14" y="15" width="18" height="18" rx="2" fill="#2684FC" />
      <rect x="6" y="15" width="10" height="18" rx="2" fill="#FFBA00" />
      <rect x="6" y="15" width="6" height="18" fill="#00AC47" opacity="0" />
    </svg>
  );
}

export function FormsLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <path d="M12 4h16l8 8v30a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#7248B9" />
      <path d="M28 4l8 8h-8z" fill="#C9B2E8" />
      <path d="M16.5 21.5l1.6 1.6 2.6-2.6" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 27.5l1.6 1.6 2.6-2.6" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="23" y="20.5" width="9" height="2" rx="1" fill="#fff" />
      <rect x="23" y="26.5" width="9" height="2" rx="1" fill="#fff" />
    </svg>
  );
}

export function ChatLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <path d="M8 8h32a2 2 0 0 1 2 2v22a2 2 0 0 1-2 2H20l-8 7v-7H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" fill="#00AC47" />
      <circle cx="18" cy="21" r="2.4" fill="#fff" />
      <circle cx="25" cy="21" r="2.4" fill="#fff" />
      <circle cx="32" cy="21" r="2.4" fill="#fff" />
    </svg>
  );
}

export function ContactsLogo({ size = 32, className }: LogoProps) {
  return (
    <svg {...box(size, className)}>
      <circle cx="24" cy="24" r="19" fill="#1A73E8" />
      <circle cx="24" cy="20" r="6" fill="#fff" />
      <path d="M13 36a11 11 0 0 1 22 0z" fill="#fff" />
    </svg>
  );
}

export type GoogleServiceKey = 'gmail' | 'drive' | 'docs' | 'sheets' | 'slides' | 'calendar' | 'tasks' | 'meet' | 'forms' | 'chat' | 'contacts';

export const SERVICE_LOGOS: Record<GoogleServiceKey, (p: LogoProps) => JSX.Element> = {
  gmail: GmailLogo,
  drive: DriveLogo,
  docs: DocsLogo,
  sheets: SheetsLogo,
  slides: SlidesLogo,
  calendar: CalendarLogo,
  tasks: TasksLogo,
  meet: MeetLogo,
  forms: FormsLogo,
  chat: ChatLogo,
  contacts: ContactsLogo,
};
