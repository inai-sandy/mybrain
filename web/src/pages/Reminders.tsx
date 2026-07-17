import { RemindersTab } from './Contacts';

/**
 * Reminders — the WhatsApp reminders workspace, split out of Contacts into its own page (BEA-1000).
 * The UI itself (conversations inbox + manage view + suggestions) lives in RemindersTab, reused as-is;
 * reminders still belong to a contact (the "+ New reminder" form keeps its contact picker).
 */
export function Reminders() {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-extrabold">Reminders</h1>
        <p className="text-sm text-zinc-500">The WhatsApp nudges you send your contacts — chats, schedules, and replies.</p>
      </header>
      <RemindersTab />
    </div>
  );
}
