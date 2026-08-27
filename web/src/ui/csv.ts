/**
 * EXPORT A LIST AS CSV (BEA-1509).
 *
 * His own CRUD standard asks for export and nothing in the app had it: not an agent's runs, not what
 * it had made, not the agents themselves. A list you cannot get out of the app is a list you cannot
 * check, share, or keep once the agent is deleted.
 *
 * Pure on purpose — the escaping is the part that goes wrong, and it deserves tests rather than a
 * hopeful glance at a spreadsheet.
 */

/**
 * One CSV cell.
 *
 * Quotes when the value contains a comma, a quote, a newline, or leading/trailing spaces a
 * spreadsheet would otherwise eat, and doubles any quote inside. `null` and `undefined` become empty
 * — the string "null" in a sheet is a lie about the data.
 */
export function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  const needsQuotes = /[",\n\r]/.test(s) || s !== s.trim();
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows to CSV text, with a header row. Uses CRLF, which is what spreadsheets expect. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
  return lines.join('\r\n');
}

/**
 * Hand the file to the browser.
 *
 * A BOM goes first so Excel opens UTF-8 correctly — without it, a Notion page title with an em dash
 * or an emoji arrives as mojibake, which looks like our bug and is not.
 */
export function downloadCsv(filename: string, headers: string[], rows: unknown[][]): void {
  const blob = new Blob(['﻿' + toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Freed on the next tick: revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A filename that sorts by date and has nothing in it a filesystem will argue with. */
export function csvName(what: string, when: Date = new Date()): string {
  const day = when.toISOString().slice(0, 10);
  const safe = String(what || 'export').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'export';
  return `${safe}-${day}.csv`;
}
