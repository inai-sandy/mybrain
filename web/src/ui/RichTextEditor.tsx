import { useEffect, useRef } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import { Bold, Italic, Strikethrough, List, ListOrdered, Quote, Code, Heading1, Heading2, Heading3, Link2, Undo, Redo, Minus } from 'lucide-react';

/** WYSIWYG / Notion-style block editor that reads & writes markdown, so it's interchangeable with the
 *  CodeMirror markdown editor and the .md storage. (BEA-556) */
export function RichTextEditor({ value, onChange }: { value: string; onChange: (md: string) => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder: 'Write something… use the toolbar to format.' }),
      Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true, breaks: true }),
    ],
    editorProps: { attributes: { class: 'prose prose-sm sm:prose-base prose-zinc dark:prose-invert max-w-none focus:outline-none min-h-[320px] px-3.5 py-3' } },
    onUpdate: ({ editor }) => onChange((editor.storage as any).markdown.getMarkdown()),
  });

  // Load the markdown content once the editor is ready (tiptap-markdown parses the md string).
  const loaded = useRef(false);
  useEffect(() => {
    if (editor && !loaded.current) {
      loaded.current = true;
      if (value) editor.commands.setContent(value, false);
    }
  }, [editor, value]);

  if (!editor) return <div className="min-h-[340px] rounded-lg border border-zinc-300 dark:border-zinc-700" />;

  return (
    <div className="rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const Btn = ({ on, active, title, children }: { on: () => void; active?: boolean; title: string; children: React.ReactNode }) => (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => { e.preventDefault(); on(); }}
      className={'h-8 w-8 grid place-items-center rounded-md transition-colors ' + (active ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}
    >
      {children}
    </button>
  );
  const c = () => editor.chain().focus();
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/40 px-1.5 py-1">
      <Btn title="Heading 1" active={editor.isActive('heading', { level: 1 })} on={() => c().toggleHeading({ level: 1 }).run()}><Heading1 size={16} /></Btn>
      <Btn title="Heading 2" active={editor.isActive('heading', { level: 2 })} on={() => c().toggleHeading({ level: 2 }).run()}><Heading2 size={16} /></Btn>
      <Btn title="Heading 3" active={editor.isActive('heading', { level: 3 })} on={() => c().toggleHeading({ level: 3 }).run()}><Heading3 size={16} /></Btn>
      <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
      <Btn title="Bold" active={editor.isActive('bold')} on={() => c().toggleBold().run()}><Bold size={15} /></Btn>
      <Btn title="Italic" active={editor.isActive('italic')} on={() => c().toggleItalic().run()}><Italic size={15} /></Btn>
      <Btn title="Strikethrough" active={editor.isActive('strike')} on={() => c().toggleStrike().run()}><Strikethrough size={15} /></Btn>
      <Btn title="Inline code" active={editor.isActive('code')} on={() => c().toggleCode().run()}><Code size={15} /></Btn>
      <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
      <Btn title="Bullet list" active={editor.isActive('bulletList')} on={() => c().toggleBulletList().run()}><List size={16} /></Btn>
      <Btn title="Numbered list" active={editor.isActive('orderedList')} on={() => c().toggleOrderedList().run()}><ListOrdered size={16} /></Btn>
      <Btn title="Quote" active={editor.isActive('blockquote')} on={() => c().toggleBlockquote().run()}><Quote size={15} /></Btn>
      <Btn title="Code block" active={editor.isActive('codeBlock')} on={() => c().toggleCodeBlock().run()}><Code size={16} /></Btn>
      <Btn title="Divider" on={() => c().setHorizontalRule().run()}><Minus size={16} /></Btn>
      <Btn
        title="Link"
        active={editor.isActive('link')}
        on={() => {
          if (editor.isActive('link')) { c().unsetLink().run(); return; }
          const url = window.prompt('Link URL');
          if (url) c().setLink({ href: url }).run();
        }}
      ><Link2 size={15} /></Btn>
      <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
      <Btn title="Undo" on={() => c().undo().run()}><Undo size={15} /></Btn>
      <Btn title="Redo" on={() => c().redo().run()}><Redo size={15} /></Btn>
    </div>
  );
}
