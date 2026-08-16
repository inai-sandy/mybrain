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
 * What the BYTES say this file is, ignoring whatever the name claims. (BEA-1343)
 *
 * The extension is a claim, not a fact. A Word file saved as "report.docx.txt", or a PDF renamed
 * ".md", used to fall through to the plain-text path and get stored as `toString('utf8')` — pages
 * of `PK\x03\x04…`. anydoc reads real file markers, so ask it first and let the name lose.
 * Returns 'doc' for anything it converts, 'pdf' for a PDF, or null when there is no marker to read
 * (genuine text, markdown, CSV — those have none).
 */
export function kindFromBytes(buffer: Buffer): 'doc' | 'pdf' | null {
  const fmt = formatFromBytes(buffer);
  if (!fmt) return null;
  if (String(fmt) === 'pdf') return 'pdf';
  return OFFICE_EXTS.includes(String(fmt)) ? 'doc' : null;
}

/**
 * Does this look like text a person could read? Used as the last gate before storing a file's bytes
 * as a document's words. A NUL byte or invalid UTF-8 in the first few KB means binary — storing it
 * would fill the library with mojibake and, worse, index that mojibake into the brain. (BEA-1343)
 */
export function looksLikeText(buffer: Buffer): boolean {
  if (!buffer?.length) return true; // an empty file is handled elsewhere
  if (buffer.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, 4096));
    return true;
  } catch {
    return false;
  }
}

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
    // The library's own message is developer-speak ("invalid Zip archive: Could not find EOCD"),
    // so it is logged, not shown. The user gets the two things they can act on. (BEA-1339)
    console.warn(`[documents] ${filename}: ${e?.message || e}`);
    throw new Error(`Could not read “${filename}”. The file may be damaged, or protected with a password.`);
  }
  // anydoc emits <br> for a line break inside a table cell (a merged or multi-line cell). Our
  // markdown renderer doesn't allow raw HTML, so that tag showed up as literal "<br>" text on the
  // page. A space is the only safe join — a real newline would break the GFM table. (BEA-1339)
  md = (md || '').replace(/<br\s*\/?>/gi, ' ').replace(/\n{3,}/g, '\n\n').trim();
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
