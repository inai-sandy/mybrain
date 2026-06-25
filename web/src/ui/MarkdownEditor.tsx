import { useState } from 'react';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from './markdown';
import { useTheme } from './theme';

/** A CodeMirror markdown editor with a live preview (write / split / preview). (BEA-533) */
export function MarkdownEditor({ value, onChange, height = '340px' }: { value: string; onChange: (v: string) => void; height?: string }) {
  const { theme } = useTheme();
  const [mode, setMode] = useState<'write' | 'split' | 'preview'>('write');
  const extensions = [markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping];

  const editor = (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={theme === 'dark' ? 'dark' : 'light'}
      height={height}
      basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }}
      placeholder="Write in markdown…"
      className="text-sm rounded-lg overflow-hidden border border-zinc-300 dark:border-zinc-700"
    />
  );
  const preview = (
    <article className="prose prose-sm prose-zinc dark:prose-invert max-w-none overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-3" style={{ height }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{value || '*Nothing yet — start writing.*'}</ReactMarkdown>
    </article>
  );

  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 p-0.5 text-xs">
        {(['write', 'split', 'preview'] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={'px-2.5 py-1 rounded-md capitalize transition-colors ' + (mode === m ? 'bg-emerald-600 text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>
            {m}
          </button>
        ))}
      </div>
      {mode === 'write' && editor}
      {mode === 'preview' && preview}
      {mode === 'split' && <div className="grid sm:grid-cols-2 gap-2">{editor}{preview}</div>}
    </div>
  );
}
