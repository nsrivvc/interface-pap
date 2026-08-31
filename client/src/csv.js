// Reading and writing the CSV files behind the Reference Data uploads. Small
// on purpose — a spreadsheet export is all we ever parse, so this covers
// RFC 4180 (quoted fields, embedded commas/newlines, doubled quotes), CRLF
// line endings and Excel's leading BOM, and nothing more.

/** Parse CSV text into an array of rows, each an array of cell strings. */
export function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Drop trailing blank lines a text editor may have left behind
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Turn rows of cells into CSV text, quoting only where it matters. */
export function toCsv(rows) {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = v === null || v === undefined ? '' : String(v);
          return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
        })
        .join(',')
    )
    .join('\r\n');
}

/** Save CSV text as a file through the browser's download dialog. */
export function downloadCsv(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
