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
        {/* Named what it IS: the WhatsApp inbox. Chases live on tasks and contacts. (BEA-1044) */}
        <h1 className="text-2xl font-extrabold">Chats</h1>
        <p className="text-sm text-zinc-500">Your WhatsApp conversations — replies, chases going out, and anything that needs you.</p>
      </header>
      <RemindersTab />
    </div>
  );
}
