/**
 * Test doubles for Google-through-the-seam specs (BEA-1351). Not part of the build — `*.testing.ts`
 * is excluded in tsconfig.json — and imported only by spec files.
 */
import { GoogleWorkspaceService } from './google-workspace.service';

export type Upload = { originalname: string; mimetype?: string; buffer: Buffer };
export type Opts = { collectionId?: string | null; sourceUrl?: string | null };

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function fakeLibrary() {
  const saved: { file: Upload; opts?: Opts }[] = [];
  return {
    saved,
    findImported: jest.fn(async () => null),
    replaceContent: jest.fn(async (id: string) => ({ id, title: 'refreshed' })),
    refreshFromUpload: jest.fn(async (id: string) => ({ id, title: 'refreshed' })),
    ensureCollection: jest.fn(async (name: string) => `col-${name.toLowerCase().replace(/\s+/g, '-')}`),
    createFromUpload: jest.fn(async (file: Upload, opts?: Opts) => {
      saved.push({ file, opts });
      return { id: `doc-${saved.length}`, title: file.originalname.replace(/\.[^.]+$/, '') };
    }),
  };
}

/** A provider stub: one ACTIVE account per toolkit unless told otherwise, and a scripted execute. */
export function fakeProvider(answer: (actionId: string, args: any) => any, opts: { connected?: string[] | 'none' } = {}) {
  const connected = opts.connected;
  return {
    getService: jest.fn(async (slug: string) => {
      const on = connected === 'none' ? false : !connected || connected.includes(slug);
      return { slug, name: slug, connected: on, accounts: on ? [{ id: `ca_${slug}`, label: 'sandy@kiot.io', status: 'ACTIVE' }] : [] };
    }),
    execute: jest.fn(async (actionId: string, args: any) => {
      const data = await answer(actionId, args);
      if (data && data.__error) return { ok: false, error: data.__error, ms: 1 };
      return { ok: true, data, ms: 1 };
    }),
    refresh: jest.fn(),
  };
}

/** Binary content arrives as a link; stub the world's fetch to serve it. */
export function serveBytes(files: Record<string, Buffer>) {
  const orig = global.fetch;
  global.fetch = jest.fn(async (url: any) => {
    const u = String(url);
    const hit = Object.entries(files).find(([k]) => u.includes(k));
    if (!hit) return { ok: false, status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) } as any;
    const buf = hit[1];
    return { ok: true, status: 200, headers: new Headers({ 'content-length': String(buf.length) }), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) } as any;
  }) as any;
  return () => { global.fetch = orig; };
}

export function build(answer: (actionId: string, args: any) => any, opts: { connected?: string[] | 'none' } = {}) {
  const lib = fakeLibrary();
  const provider = fakeProvider(answer, opts);
  const prisma = { toolCall: { create: jest.fn(async () => ({})) } };
  const svc = new GoogleWorkspaceService(provider as any, lib as any, prisma as any);
  return { svc, lib, provider, prisma };
}

export const calls = (provider: any) => (provider.execute as jest.Mock).mock.calls.map((c: any[]) => ({ id: c[0], args: c[1], opts: c[2] }));
