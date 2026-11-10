import { ColumnDef, Size, TableFactory, TableModelIf, TrueFn } from '@guiexpert/table';
import { Cell, QueryResult } from '../../core/sql/query.models';

const CHAR_PX = 8;
const MIN_WIDTH = 60;
const MAX_WIDTH = 420;
/** Rows looked at for the column widths. */
const SAMPLE = 200;

/** A cell as text; `null` stays `null` (the renderer shows it as NULL). */
export function cellText(cell: Cell): string | null {
  if (cell === null) return null;
  if (typeof cell === 'object') return `<blob ${cell.blob} B>`;
  return String(cell);
}

/** Column widths in px from the header and the first rows. */
export function columnWidths(result: QueryResult): number[] {
  return result.columns.map((column, c) => {
    let chars = column.name.length + 2;
    const n = Math.min(result.rows.length, SAMPLE);
    for (let r = 0; r < n; r++) {
      chars = Math.max(chars, (cellText(result.rows[r][c]) ?? 'NULL').length);
    }
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, chars * CHAR_PX + 16));
  });
}

/** Numbers are right-aligned; the declared type wins over the first value. */
export function isNumeric(result: QueryResult, c: number): boolean {
  const decl = result.columns[c].declType?.toUpperCase() ?? '';
  if (/INT|REAL|FLOA|DOUB|NUM|DEC/.test(decl)) return true;
  if (decl) return false;
  const first = result.rows.find((row) => row[c] !== null)?.[c];
  return typeof first === 'number';
}

/** The table model of a result: one column per result column, rows as they came (arrays). */
export function resultModel(result: QueryResult): TableModelIf {
  const widths = columnWidths(result);
  const columnDefs = result.columns.map((column, c) =>
    ColumnDef.create({
      property: String(c),
      headerLabel: column.name,
      width: new Size(widths[c], 'px'),
      sortable: TrueFn,
      bodyClasses: isNumeric(result, c) ? ['sc-num'] : [],
    }),
  );
  return TableFactory.createTableModel({
    rows: result.rows as unknown[] as never[],
    columnDefs,
  });
}
