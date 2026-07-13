import { DocumentsService } from './documents.service';

// Rows keyed by slug, covering each gate the raw share link must honour. (BEA-970)
const ROWS: Record<string, any> = {
  'md-doc': { id: '1', slug: 'md-doc', kind: 'md', shared: true, contentText: '# Hello\n\nplain **md**', sharePassword: null, expiresAt: null },
  'html-doc': { id: '2', slug: 'html-doc', kind: 'html', shared: true, contentText: '<h1>Title</h1><p>a <b>bold</b> word</p>', sharePassword: null, expiresAt: null },
  'html-page': { id: '7', slug: 'html-page', kind: 'html', shared: true, sharePassword: null, expiresAt: null,
    contentText: '<!doctype html><html><head><title>Doc Title</title><style>:root{--bg:#0B0B0F}</style><script>var x=1;</script></head><body><h1>Real Heading</h1><p>Body text.</p></body></html>' },
  'not-shared': { id: '3', slug: 'not-shared', kind: 'md', shared: false, contentText: 'secret', sharePassword: null, expiresAt: null },
  'expired': { id: '4', slug: 'expired', kind: 'md', shared: true, contentText: 'gone', sharePassword: null, expiresAt: new Date(Date.now() - 1000) },
  'pw-doc': { id: '5', slug: 'pw-doc', kind: 'md', shared: true, contentText: 'locked', sharePassword: '$2a$hash', expiresAt: null },
  'pdf-doc': { id: '6', slug: 'pdf-doc', kind: 'pdf', shared: true, contentText: '', sharePassword: null, expiresAt: null },
};

function makeSvc() {
  const prisma: any = {
    document: {
      findUnique: async ({ where }: any) => ROWS[where.slug] ?? null,
      update: async () => ({}),
    },
  };
  return new DocumentsService(prisma, null as any, null as any);
}

describe('DocumentsService.sharedRaw — raw markdown share link (BEA-970)', () => {
  it('returns markdown as-is for a shared md doc', async () => {
    const r = await makeSvc().sharedRaw('md-doc');
    expect(r?.content).toBe('# Hello\n\nplain **md**');
  });

  it('converts a shared html doc to markdown', async () => {
    const r = await makeSvc().sharedRaw('html-doc');
    expect(r?.content).toContain('# Title');
    expect(r?.content).toContain('**bold**');
    expect(r?.content).not.toContain('<b>');
  });

  it('strips head/style/script from a full HTML page — no CSS or JS leaks into the markdown', async () => {
    const r = await makeSvc().sharedRaw('html-page');
    expect(r?.content).toContain('# Real Heading');
    expect(r?.content).toContain('Body text.');
    expect(r?.content).not.toContain('--bg');       // no CSS
    expect(r?.content).not.toContain('var x');       // no JS
    expect(r?.content).not.toContain('Doc Title');   // no <title>
    expect(r?.content).not.toMatch(/<[a-z]/i);       // no raw tags
  });

  it('returns null when the doc is not shared', async () => {
    expect(await makeSvc().sharedRaw('not-shared')).toBeNull();
  });

  it('returns null when the share has expired', async () => {
    expect(await makeSvc().sharedRaw('expired')).toBeNull();
  });

  it('returns null for a password-protected share (no plain-text bypass)', async () => {
    expect(await makeSvc().sharedRaw('pw-doc')).toBeNull();
  });

  it('returns null for a non-text doc (pdf/image)', async () => {
    expect(await makeSvc().sharedRaw('pdf-doc')).toBeNull();
  });

  it('returns null for an unknown slug', async () => {
    expect(await makeSvc().sharedRaw('nope')).toBeNull();
  });
});
