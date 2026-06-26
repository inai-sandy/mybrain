import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Download, Share2, Trash2, Pencil, Brain, Maximize2 } from 'lucide-react';
import { mdComponents, extractHeadings, OutlineLayout } from '../ui/markdown';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DocumentShareDialog } from '../ui/DocumentShareDialog';
import { useToast } from '../ui/Toast';
import { DocEditor, type DocItem } from './Documents';

type FullDoc = DocItem & { contentText: string };

export function DocumentView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [doc, setDoc] = useState<FullDoc | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [del, setDel] = useState(false);

  function load() {
    fetch(`/api/documents/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setDoc)
      .catch(() => setError('Document not found.'));
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function remove() {
    setDel(false);
    const r = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    if (r.ok) {
      toast('success', 'Deleted');
      navigate('/documents');
    } else toast('error', 'Could not delete');
  }

  async function toMemory() {
    const r = await fetch(`/api/documents/${id}/convert`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (r.ok) toast('success', d.deduped ? 'Already in your memory' : 'Added to your memory (Capture)');
    else toast('error', d.message || 'Could not add to memory');
  }

  const btn = 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800';

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <button onClick={() => navigate('/documents')} className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft size={15} /> Documents</button>

      {error && <p className="text-amber-500">{error}</p>}

      {doc && (
        <>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h1 className="text-2xl font-extrabold">{doc.title}</h1>
              <p className="mt-1 text-xs text-zinc-400">{doc.kind.toUpperCase()}{doc.shared && <> · <span className="text-emerald-600">shared</span></>}</p>
              {doc.tags?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {doc.tags.map((t) => <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">{t}</span>)}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => setEditing(true)} className={btn}><Pencil size={15} /> Edit</button>
              <a href={`/api/documents/${doc.id}/download`} className={btn}><Download size={15} /> Download</a>
              <button onClick={() => setSharing(true)} className={btn}><Share2 size={15} /> Share</button>
              {doc.kind !== 'image' && <button onClick={toMemory} className={btn} title="Copy into Capture / memory"><Brain size={15} /> To Memory</button>}
              <button onClick={() => setDel(true)} className={btn + ' hover:text-red-500'}><Trash2 size={15} /> Delete</button>
            </div>
          </div>

          {doc.kind === 'pdf' ? (
            <iframe title={doc.title} src={`/api/documents/${doc.id}/file`} className="w-full min-h-[80vh] rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white" />
          ) : doc.kind === 'image' ? (
            <img src={`/api/documents/${doc.id}/file`} alt={doc.title} className="max-w-full rounded-xl border border-zinc-200 dark:border-zinc-800" />
          ) : doc.kind === 'html' ? (
            <div className="space-y-2">
              <div className="flex justify-end">
                <button onClick={() => navigate(`/documents/${doc.id}/full`)} className={btn}><Maximize2 size={15} /> Open full page</button>
              </div>
              <iframe title={doc.title} srcDoc={doc.contentText} className="w-full min-h-[70vh] rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms" />
            </div>
          ) : (
            <OutlineLayout headings={extractHeadings(doc.contentText || '')}>
              <article className="prose prose-zinc dark:prose-invert max-w-none border-t border-zinc-200 dark:border-zinc-800 pt-5">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{doc.contentText || '*(empty document)*'}</ReactMarkdown>
              </article>
            </OutlineLayout>
          )}
        </>
      )}

      {editing && doc && <DocEditor doc={doc} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
      {sharing && doc && <DocumentShareDialog id={doc.id} title={doc.title} slug={doc.slug} shortCode={doc.shortCode} initialShared={doc.shared} onClose={() => setSharing(false)} onChanged={() => load()} />}
      <ConfirmDialog open={del} title="Delete this document?" message={doc ? `"${doc.title}" will be permanently removed.` : ''} confirmLabel="Delete" onCancel={() => setDel(false)} onConfirm={remove} />
    </div>
  );
}
