import { useState } from 'react';
import { Upload, Link2, FileText } from 'lucide-react';
import { useToast } from '../ui/Toast';

export function Capture() {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  function notify(r: Response, d: any, okWord = 'Saved to your brain ✓') {
    if (r.ok) toast('success', d?.deduped ? 'Already saved — no duplicate' : okWord);
    else toast('error', d?.message || 'Something went wrong');
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/items/upload', { method: 'POST', body: fd });
      notify(r, await r.json().catch(() => ({})));
    } catch {
      toast('error', 'Upload failed');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  async function handleUrl() {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/items/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const d = await r.json().catch(() => ({}));
      notify(r, d);
      if (r.ok) setUrl('');
    } catch {
      toast('error', 'Could not fetch that link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Capture</h1>
        <p className="text-zinc-500">Add to your brain — it’s stored safely and remembered in both memory stores.</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="flex items-center gap-2 font-semibold mb-1">
            <Upload size={18} className="text-emerald-600" /> Upload markdown
          </div>
          <p className="text-sm text-zinc-500 mb-4">Pick a .md file from your device.</p>
          <label className="inline-block">
            <input type="file" accept=".md,.markdown,.txt" onChange={handleFile} disabled={busy} className="hidden" />
            <span className="cursor-pointer inline-block rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm">
              {busy ? 'Working…' : 'Choose file'}
            </span>
          </label>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="flex items-center gap-2 font-semibold mb-1">
            <Link2 size={18} className="text-emerald-600" /> Paste a public link
          </div>
          <p className="text-sm text-zinc-500 mb-4">A public URL to a markdown or text file.</p>
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
            />
            <button
              onClick={handleUrl}
              disabled={busy}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm disabled:opacity-60"
            >
              Save
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-5 sm:col-span-2 text-center text-zinc-400">
          <FileText size={20} className="mx-auto mb-2" /> Pull a Notion page — coming next.
        </div>
      </div>
    </div>
  );
}
