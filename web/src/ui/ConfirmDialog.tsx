export function ConfirmDialog({
  open = true, // optional — when rendered conditionally ({cond && <ConfirmDialog/>}) it is simply open
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
  busy = false,
}: {
  open?: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** In flight. Without this the confirm button stays live while the request runs, and a quick
   *  double-tap sends it twice — on a delete that is two deletes. (BEA-1315) */
  busy?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl">
        <h3 className="font-bold mb-1">{title}</h3>
        {message && <p className="text-sm text-zinc-500 mb-4">{message}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy} className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm hover:bg-red-500 disabled:opacity-50">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
