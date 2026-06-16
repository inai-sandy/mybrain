import type { GoogleServiceKey } from './logos';
import { GmailPanel, DrivePanel, DocsPanel, SheetsPanel, SlidesPanel, CalendarPanel, TasksPanel, MeetPanel, FormsPanel, ChatPanel, ContactsPanel } from './panels';

export type ServiceDef = { key: GoogleServiceKey; label: string; tagline: string; Panel: () => JSX.Element };

/** Order = order on the launcher grid. */
export const SERVICES: ServiceDef[] = [
  { key: 'gmail', label: 'Gmail', tagline: 'Email brief & requests', Panel: GmailPanel },
  { key: 'calendar', label: 'Calendar', tagline: 'Your upcoming agenda', Panel: CalendarPanel },
  { key: 'tasks', label: 'Tasks', tagline: 'Your Google Tasks', Panel: TasksPanel },
  { key: 'drive', label: 'Drive', tagline: 'Browse & import files', Panel: DrivePanel },
  { key: 'docs', label: 'Docs', tagline: 'Create a document', Panel: DocsPanel },
  { key: 'sheets', label: 'Sheets', tagline: 'Create a spreadsheet', Panel: SheetsPanel },
  { key: 'slides', label: 'Slides', tagline: 'Create a presentation', Panel: SlidesPanel },
  { key: 'meet', label: 'Meet', tagline: 'New meeting link', Panel: MeetPanel },
  { key: 'forms', label: 'Forms', tagline: 'Your Google Forms', Panel: FormsPanel },
  { key: 'chat', label: 'Chat', tagline: 'Spaces & messages', Panel: ChatPanel },
  { key: 'contacts', label: 'Contacts', tagline: 'Your contacts', Panel: ContactsPanel },
];

export const SERVICE_BY_KEY: Record<string, ServiceDef> = Object.fromEntries(SERVICES.map((s) => [s.key, s]));
