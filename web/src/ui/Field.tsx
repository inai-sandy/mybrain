import { InputHTMLAttributes } from 'react';

export function Field({
  label,
  error,
  ...props
}: { label: string; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block mb-3 text-sm">
      <span className="block mb-1 text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        {...props}
        className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 outline-none focus:border-emerald-500"
      />
      {error && <span className="block mt-1 text-amber-500">{error}</span>}
    </label>
  );
}
