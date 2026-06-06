import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, MessageCircle } from 'lucide-react';

export function ChatDoc() {
  const { id } = useParams();
  const [title, setTitle] = useState('');

  useEffect(() => {
    fetch(`/api/items/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setTitle(d.title || ''))
      .catch(() => undefined);
  }, [id]);

  return (
    <div className="space-y-5">
      <Link to="/capture" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={16} /> Back to documents
      </Link>

      <div>
        <h1 className="text-2xl font-extrabold flex items-center gap-2">
          <MessageCircle className="text-emerald-600" size={22} /> Chat
        </h1>
        <p className="text-zinc-500">
          Pointed at: <span className="font-medium text-zinc-900 dark:text-zinc-100">{title || 'this document'}</span>
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-white/50 dark:bg-zinc-900/40 p-10 text-center">
        <MessageCircle size={32} className="mx-auto mb-3 text-zinc-400" />
        <p className="text-zinc-500">Chat with this document — coming soon.</p>
        <p className="text-sm text-zinc-400 mt-1">You'll be able to ask questions answered only from this document, not your whole brain.</p>
      </div>
    </div>
  );
}
