/**
 * A block of cells as text (prompt 032): what a spreadsheet puts on the clipboard – lines of cells
 * separated by **tabs**; a cell is in double quotes when it holds a tab, a line break or a quote (`""`).
 * Without a tab every line is one cell: a separator is never guessed (a column of `1,5` or of
 * `Smith, John` must not spill into the column beside it). Pure.
 */

/** Rows and cells taken from a block at most. */
export const MAX_BLOCK_ROWS = 20_000;
export const MAX_BLOCK_COLUMNS = 2_000;

/**
 * Where the quoted cell that starts at `from` (a `"`) ends: the index behind its closing quote – if
 * that quote is followed by a tab, a line end or the end of the text. Else `-1`: the quote is a
 * character like any other (a cell that merely starts with one must not swallow the cells behind it).
 */
function quotedEnd(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] !== '"') continue;
    if (text[i + 1] === '"') {
      i++;
      continue;
    }
    const next = text[i + 1];
    return next === undefined || next === '\t' || next === '\n' || next === '\r' ? i + 1 : -1;
  }
  return -1;
}

/**
 * The cells of a block. A last line that is empty (the line break a spreadsheet ends with) is no row.
 * `cut`: the block had more rows than are taken.
 */
export function parseBlock(text: string): { rows: string[][]; cut: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let started = false;
  let cut = false;
  const endCell = () => {
    if (row.length < MAX_BLOCK_COLUMNS) row.push(cell);
    cell = '';
    started = false;
  };
  const endRow = () => {
    endCell();
    if (rows.length < MAX_BLOCK_ROWS) rows.push(row);
    else cut = true;
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && !started) {
      const end = quotedEnd(text, i);
      if (end > 0) {
        cell = text.slice(i + 1, end - 1).replaceAll('""', '"');
        started = true;
        i = end - 1;
        continue;
      }
    }
    if (ch === '\t') endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else {
      cell += ch;
      started = true;
    }
  }
  // what stands behind the last line break is a row, unless it is nothing
  if (started || row.length > 0) endRow();
  return { rows, cut };
}
