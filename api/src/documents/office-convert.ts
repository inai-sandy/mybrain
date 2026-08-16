import { extname } from 'path';
import { toMarkdownBytes, formatFromBytes, formatFromExtension } from '@firecrawl/anydoc';

/**
 * Office / e-book / spreadsheet files → GitHub-flavoured Markdown, via @firecrawl/anydoc (BEA-1339).
 *
 * anydoc is a self-contained Rust library: no API key, no network call, no ML model. It ships a
 * prebuilt `linux-x64-musl` binary, which is what the `node:22-alpine` runtime image needs — there
 * is no Rust toolchain in the build.
 *
 * PDFs are deliberately NOT routed through here. On a text PDF anydoc extracted ~a third less text
 * than `pdf-parse` and lost column order, so pdf-parse stays the extractor. anydoc is used for PDFs
 * only to answer "is there any text in here at all?" — see `pdfHasNoTextToRead`.
 */

/** Upload cap for an office file, matching the 80 MB unzipped cap on the ZIP/site path. */
const MAX_INPUT_BYTES = 40 * 1024 * 1024;

/** Cap on the markdown a single file may produce — a zip bomb's whole point is a tiny input. */
const MAX_MARKDOWN_CHARS = 5 * 1024 * 1024;

/** Extensions anydoc converts. PDF is excluded on purpose (pdf-parse handles it). */
export const OFFICE_EXTS = [
  'doc', 'docx', 'docm',
  'ppt', 'pps', 'pot', 'pptx', 'pptm', 'ppsx', 'ppsm',
  'xls', 'xlsx', 'xlsm', 'xlsb',
  'odt', 'ods', 'odp',
  'rtf', 'epub', 'csv',
];

/** The `accept` list the file picker offers, kept next to the list it must match. */
export const OFFICE_ACCEPT = OFFICE_EXTS.map((e) => `.${e}`).join(',');

const extOf = (name: string) => extname(name || '').toLowerCase().replace('.', '');

/** Is this a file anydoc can turn into markdown? */
export const isOfficeFile = (name: string): boolean => OFFICE_EXTS.includes(extOf(name));

/**
 * Convert an office file to markdown. Throws with a plain-English message the upload route can show.
 *
 * Format detection reads the file's own markers first, so a mislabelled file still converts. CSV has
 * no marker to read (`formatFromBytes` returns null for it), so the extension is the fallback —
 * without it every CSV upload fails with "unrecognized file content".
 */
export async function officeToMarkdown(buffer: Buffer, filename: string): Promise<string> {
  // docx/xlsx/pptx/odt/ods/odp are zip containers, so a small upload can decompress into a huge
  // document. We never extract them — anydoc converts in memory — but the conversion still holds the
  // result, so cap both ends the way createFromZip caps the site path. (BEA-1339)
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new Error(`That file is too big (max ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)} MB).`);
  }
  const fmt = formatFromBytes(buffer) || formatFromExtension(extOf(filename)) || undefined;
  let md = '';
  try {
    md = await toMarkdownBytes(buffer, fmt);
  } catch (e: any) {
    throw new Error(`Could not read that ${extOf(filename) || 'file'} — ${e?.message || 'it may be corrupt or password-protected.'}`);
  }
  md = (md || '').replace(/\n{3,}/g, '\n\n').trim();
  if (!md) throw new Error(`That ${extOf(filename) || 'file'} had no readable content.`);
  if (md.length > MAX_MARKDOWN_CHARS) {
    throw new Error(`That ${extOf(filename) || 'file'} is too long to store (it turned into over ${Math.round(MAX_MARKDOWN_CHARS / 1024 / 1024)} MB of text).`);
  }
  return md;
}

/**
 * Why did a PDF yield no text? `pdf-parse` returns an empty string for a scanned PDF *and* for a
 * broken one, with no error either way — which is how scans ended up saved silently blank. anydoc
 * throws a typed `unsupported` error naming the reason, so we can tell the user the truth.
 * Only called when pdf-parse already came back empty, so it costs nothing on the normal path.
 *
 * It reports "no text, needs OCR" — it does NOT prove the pages are scans. anydoc labels a PDF with
 * genuinely blank pages `Scanned` as well, so the message shown to the user must stay honest about
 * that ("a scan or an image-only PDF"), and a corrupt file throws a different message and is
 * correctly excluded here.
 */
export async function pdfHasNoTextToRead(buffer: Buffer): Promise<boolean> {
  try {
    await toMarkdownBytes(buffer);
    return false; // anydoc read text where pdf-parse found none — there is text after all.
  } catch (e: any) {
    return e?.code === 'unsupported' && /image|ocr|no extractable text/i.test(e?.message || '');
  }
}
