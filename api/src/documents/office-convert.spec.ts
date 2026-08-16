import AdmZip from 'adm-zip';
import { isOfficeFile, officeToMarkdown, pdfHasNoTextToRead, kindFromBytes, readAsText, OFFICE_EXTS } from './office-convert';

/**
 * Locks the office-file → markdown path added in BEA-1339.
 *
 * Fixtures are built in code rather than committed as binaries: a hand-written .docx package and
 * hand-written PDFs, so the suite stays readable and the repo stays free of opaque test blobs.
 */

/** The smallest .docx that Word and anydoc both accept: content types, a rels part, and a body. */
function docx(bodyXml: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    ),
  );
  zip.addFile(
    '_rels/.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    ),
  );
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        bodyXml +
        '</w:body></w:document>',
    ),
  );
  return zip.toBuffer();
}

const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const cell = (t: string) => `<w:tc>${para(t)}</w:tc>`;
const trow = (...cells: string[]) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;

/** A minimal single-page PDF. `objs` are the numbered objects, in order. */
function pdf(objs: string[]): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = out.length;
  out +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function textPdf(): Buffer {
  const content = 'BT /F1 24 Tf 20 100 Td (Hello from a text PDF) Tj ET';
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

/** A page whose only content draws an image — a stand-in for a scanned page. */
function imageOnlyPdf(): Buffer {
  const img = '\x00\xff\x00\xff\x00\xff\x00\xff\x00\xff\x00\xff';
  const content = 'q 200 0 0 200 0 0 cm /Im0 Do Q';
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${img.length} >>\nstream\n${img}\nendstream`,
  ]);
}

describe('isOfficeFile', () => {
  it('claims the office formats and leaves the existing kinds alone', () => {
    for (const ext of OFFICE_EXTS) expect(isOfficeFile(`quote.${ext}`)).toBe(true);
    expect(isOfficeFile('Quote.DOCX')).toBe(true); // extensions arrive in any case
    for (const other of ['notes.md', 'page.html', 'report.pdf', 'photo.png', 'site.zip', 'noextension']) {
      expect(isOfficeFile(other)).toBe(false);
    }
  });
});

describe('officeToMarkdown', () => {
  it('turns a Word file into markdown and keeps its table', async () => {
    const buf = docx(para('Terms are 50/50.') + `<w:tbl>${trow('Part', 'Qty')}${trow('ESP32-S3', '25')}</w:tbl>`);
    const md = await officeToMarkdown(buf, 'Vendor Quote.docx');
    expect(md).toContain('Terms are 50/50.');
    expect(md).toContain('| Part | Qty |'); // the table must survive, not flatten into prose
    expect(md).toContain('| ESP32-S3 | 25 |');
  });

  it('never leaves a raw <br> tag in a table cell, which the renderer would show as text', async () => {
    // A merged / multi-line Word cell comes out of anydoc as "line one<br>line two". The markdown
    // renderer escapes raw HTML, so that used to appear on the page literally as "<br>".
    const buf = docx(`<w:tbl>${trow('Part', 'Qty')}<w:tr><w:tc>${para('AMOLED')}${para('spare')}</w:tc>${cell('25')}</w:tr></w:tbl>`);
    const md = await officeToMarkdown(buf, 'merged.docx');
    expect(md).not.toMatch(/<br\s*\/?>/i);
    expect(md).toContain('AMOLED spare');
  });

  it('converts a CSV, which has no content marker to sniff', async () => {
    // The regression this guards: anydoc's formatFromBytes returns null for CSV, so without the
    // extension fallback every CSV upload failed with "unrecognized file content".
    const md = await officeToMarkdown(Buffer.from('name,qty,rate\nboard,10,1200\n'), 'prices.csv');
    expect(md).toContain('| name | qty | rate |');
    expect(md).toContain('| board | 10 | 1200 |');
  });

  it('fails with a readable message instead of crashing on a file it cannot read', async () => {
    await expect(officeToMarkdown(Buffer.from('this is not a docx'), 'broken.docx')).rejects.toThrow(/could not read/i);
  });

  it('fails with a readable message when the file is empty', async () => {
    await expect(officeToMarkdown(Buffer.from(''), 'empty.csv')).rejects.toThrow(/no readable content|could not read/i);
  });

  it('refuses an oversized file before handing it to the converter', async () => {
    // Office formats are zip containers, so an upload is capped the way the ZIP/site path is.
    const huge = Buffer.alloc(41 * 1024 * 1024);
    await expect(officeToMarkdown(huge, 'huge.docx')).rejects.toThrow(/too big \(max 40 MB\)/i);
  });
});

describe('pdfHasNoTextToRead', () => {
  it('is true for an image-only page, so a scan is never saved silently blank', async () => {
    expect(await pdfHasNoTextToRead(imageOnlyPdf())).toBe(true);
  });

  it('is false when the PDF really does have text', async () => {
    expect(await pdfHasNoTextToRead(textPdf())).toBe(false);
  });

  it('is false for a corrupt file — that is a broken upload, not a missing-OCR problem', async () => {
    expect(await pdfHasNoTextToRead(Buffer.from('%PDF-1.4 and then garbage'))).toBe(false);
  });
});

describe('kindFromBytes — the name is a claim, the bytes are the fact (BEA-1343)', () => {
  it('sees a Word file however it is named', () => {
    expect(kindFromBytes(docx(para('hi')))).toBe('doc');
  });

  it('sees a PDF however it is named', () => {
    expect(kindFromBytes(textPdf())).toBe('pdf');
  });

  it('says nothing about genuine text, which has no marker to read', () => {
    expect(kindFromBytes(Buffer.from('# Just a markdown note\n'))).toBeNull();
    expect(kindFromBytes(Buffer.from('name,qty\nboard,10\n'))).toBeNull();
  });
});

describe('readAsText — different encoding is not the same as binary (BEA-1344)', () => {
  const utf16le = (t: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]);

  it('reads plain UTF-8, accents and emoji', () => {
    expect(readAsText(Buffer.from('# Héllo — wörld 🌍'))).toBe('# Héllo — wörld 🌍');
    expect(readAsText(Buffer.from(''))).toBe('');
  });

  it('reads a UTF-16 file, whose NUL bytes are structure and not binary', () => {
    // Notepad's "Unicode" save and PowerShell redirects both produce this; it used to be refused.
    expect(readAsText(utf16le('# Hello world'))).toBe('# Hello world');
  });

  it('reads a legacy latin1 / Windows-1252 note instead of refusing it', () => {
    expect(readAsText(Buffer.from('Caf\xe9 notes', 'latin1'))).toBe('Café notes');
  });

  it('strips a UTF-8 byte-order mark', () => {
    expect(readAsText(Buffer.from('\ufeff# Title'))).toBe('# Title');
  });

  it('refuses genuinely binary content', () => {
    expect(readAsText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]))).toBeNull();
    expect(readAsText(docx(para('hi')))).toBeNull();
  });

  it('looks at the WHOLE file, not just the opening', () => {
    // Clean prose first, binary later — the old 8KB sample passed this and stored the junk.
    const sneaky = Buffer.concat([Buffer.from('a'.repeat(9000)), Buffer.from([0x00, 0xff, 0xfe])]);
    expect(readAsText(sneaky)).toBeNull();
  });
});

describe('formats we cannot read (BEA-1344)', () => {
  it('tells the owner what to do about a legacy .xls instead of a vague failure', async () => {
    await expect(officeToMarkdown(Buffer.from('anything'), 'book.xls')).rejects.toThrow(/save it as \.xlsx/i);
  });

  it('no longer advertises formats anydoc cannot read', () => {
    expect(OFFICE_EXTS).not.toContain('xls');
    expect(OFFICE_EXTS).not.toContain('xlsb');
    expect(OFFICE_EXTS).toContain('xlsx');
    expect(OFFICE_EXTS).toContain('docx');
  });
});
