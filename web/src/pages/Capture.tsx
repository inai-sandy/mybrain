import { ReactNode, useState } from 'react';
import { Upload, Link2, FileText, X } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { DocumentsList } from './DocumentsList';

type Door = 'upload' | 'url' | 'notion' | null;

export function Capture() {
  const toast = useToast();
  const [door, setDoor] = useState<Door>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [url, setUrl] = useState('');
  const [notionUrl, setNotionUrl] = useState('');
  const [tags, setTags] = useState('');

  function done(r: Response, d: any) {
    if (r.ok) {
      toast('success', d?.deduped ? 'Already saved — no duplicate' : 'Saved to your brain ✓');
      setDoor(null);
      setUrl('');
      setNotionUrl('');
      setTags('');
      setRefreshKey((k) => k + 1);
    } else toast('error', d?.message || 'Something went wrong');
  }

  const TagsField = (
    <input
      value={tags}
      onChange={(e) => setTags(e.target.value)}
      placeholder="Tags (comma-separated, optional)"
      className="mt-3 w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
    />
  );

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('tags', tags);
      const r = await fetch('/api/items/upload', { method: 'POST', body: fd });
      done(r, await r.json().catch(() => ({})));
    } catch {
      toast('error', 'Upload failed');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  async function post(path: string, body: any) {
    setBusy(true);
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      done(r, await r.json().catch(() => ({})));
    } catch {
      toast('error', 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const btn = 'inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Capture</h1>
          <p className="text-zinc-500">Add to your brain — stored safely and remembered.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setDoor('upload')} className={btn}>
            <Upload size={16} /> Upload
          </button>
          <button onClick={() => setDoor('url')} className={btn}>
            <Link2 size={16} /> Paste link
          </button>
          <button onClick={() => setDoor('notion')} className={btn}>
            <FileText size={16} /> Notion
          </button>
        </div>
      </div>

      <DocumentsList key={refreshKey} />

      {door === 'upload' && (
        <Modal title="Upload markdown" onClose={() => setDoor(null)}>
          <p className="text-sm text-zinc-500 mb-4">Pick a .md file from your device.</p>
          <label className="inline-block">
            <input type="file" accept=".md,.markdown,.txt" onChange={handleFile} disabled={busy} className="hidden" />
            <span className={btn + ' cursor-pointer'}>{busy ? 'Working…' : 'Choose file'}</span>
          </label>
          {TagsField}
        </Modal>
      )}

      {door === 'url' && (
        <Modal title="Paste a public link" onClose={() => setDoor(null)}>
          <p className="text-sm text-zinc-500 mb-4">A public URL to a markdown or text file.</p>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            autoFocus
            className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          {TagsField}
          <div className="mt-4 text-right">
            <button onClick={() => url.trim() && post('/api/items/url', { url, tags })} disabled={busy} className={btn}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {door === 'notion' && (
        <Modal title="Import a Notion page" onClose={() => setDoor(null)}>
          <p className="text-sm text-zinc-500 mb-4">
            Paste a Notion page link. (First time: add your Notion token in Settings → Integrations and share the page with the
            integration.)
          </p>
          <input
            value={notionUrl}
            onChange={(e) => setNotionUrl(e.target.value)}
            placeholder="https://www.notion.so/…"
            autoFocus
            className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          {TagsField}
          <div className="mt-4 text-right">
            <button onClick={() => notionUrl.trim() && post('/api/items/notion', { url: notionUrl, tags })} disabled={busy} className={btn}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
