export function ConfirmDialog({
  open = true, // optional — when rendered conditionally ({cond && <ConfirmDialog/>}) it is simply open
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: {
  open?: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl">
        <h3 className="font-bold mb-1">{title}</h3>
        {message && <p className="text-sm text-zinc-500 mb-4">{message}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm">
            Cancel
          </button>
          <button onClick={onConfirm} className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm hover:bg-red-500">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
