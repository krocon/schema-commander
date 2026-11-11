/**
 * A block of cells as text (prompt 032): what a spreadsheet puts on the clipboard – lines of cells
 * separated by tabs, a cell in double quotes when it holds a tab, a line break or a quote (`""`) – or a
 * CSV with commas or semicolons. Pure.
 */

/** Rows and cells taken from a block at most. */
export const MAX_BLOCK_ROWS = 20_000;
export const MAX_BLOCK_COLUMNS = 2_000;

/** The separator of a block: a tab if there is one, else what the first line has more of. */
export function separatorOf(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  if (text.includes('\t')) return '\t';
  const count = (ch: string) => first.split(ch).length - 1;
  return count(';') > count(',') ? ';' : ',';
}

/**
 * The cells of a block. A last line that is empty (the line break a spreadsheet ends with) is no row.
 * `cut`: the block had more rows than are taken.
 */
export function parseBlock(text: string): { rows: string[][]; cut: boolean } {
  const sep = separatorOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  let cut = false;
  const endCell = () => {
    if (row.length < MAX_BLOCK_COLUMNS) row.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    if (rows.length < MAX_BLOCK_ROWS) rows.push(row);
    else cut = true;
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === sep) endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
  }
  // what stands behind the last line break is a row, unless it is nothing
  if (cell !== '' || row.length > 0 || wasQuoted) endRow();
  return { rows, cut };
}
