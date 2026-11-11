import { QueryColumn, RowWindow } from '../../core/sql/query.models';
import {
  MAX_PAGES,
  PAGE_ROWS,
  WindowAreaModel,
  cellText,
  columnWidths,
  isNumeric,
  numberWidth,
  pagesToDrop,
  resultModel,
  shownRows,
} from './result-model';

const COLUMNS: QueryColumn[] = [
  { name: 'id', kind: 'int', typeName: 'INT4' },
  { name: 'name', kind: 'text', typeName: 'TEXT' },
  { name: 'n', kind: 'other', typeName: '' },
  { name: 'big', kind: 'int', typeName: 'INT8' },
];
const FIRST: RowWindow = [
  [1, 'Ada Lovelace', null, '9223372036854775807'],
  [2, null, 2.5, 7],
  [3, 'x'.repeat(500), { bytes: 40, hex: '00ff' }, 8],
];

/** A store of `total` rows `[n, "row n"]` that counts what is asked of it. */
function store(total: number) {
  const asked: number[] = [];
  let resolvers: (() => void)[] = [];
  const fetch = (from: number, count: number) => {
    asked.push(from);
    const rows: RowWindow = Array.from(
      { length: Math.max(0, Math.min(count, total - from)) },
      (_, i) => [from + i, `row ${from + i}`],
    );
    return new Promise<RowWindow>((resolve) => resolvers.push(() => resolve(rows)));
  };
  const flush = async () => {
    const all = resolvers;
    resolvers = [];
    all.forEach((r) => r());
    await Promise.resolve();
    await Promise.resolve();
  };
  return { fetch, asked, flush };
}

describe('result cells and columns', () => {
  it('turns cells into text and keeps NULL apart', () => {
    expect(cellText(null)).toBeNull();
    expect(cellText(2.5)).toBe('2.5');
    expect(cellText(true)).toBe('true');
    expect(cellText({ bytes: 40, hex: '00ff' })).toBe('0x00ff… (40 B)');
    expect(cellText({ bytes: 2, hex: '00ff' })).toBe('0x00ff (2 B)');
    expect(cellText({ unreadable: 'GEOMETRY' })).toBe('‹GEOMETRY›');
  });

  it('shows numbers and text as they are, everything else as text', () => {
    const shown = shownRows(FIRST);
    expect(shown[2][2]).toBe('0x00ff… (40 B)');
    expect(shown[0][3]).toBe('9223372036854775807');
    expect(shownRows([[true, null, false, 1]])[0]).toEqual(['true', null, 'false', 1]);
  });

  it('sizes columns within limits and the row numbers by the row count', () => {
    const [id, name] = columnWidths(COLUMNS, FIRST);
    expect(id).toBe(60);
    expect(name).toBe(420);
    expect(numberWidth(999)).toBeLessThan(numberWidth(10_000_000));
  });

  it('knows numeric columns by kind, and by the first value when the kind is unknown', () => {
    expect(isNumeric(COLUMNS, 0, FIRST)).toBe(true);
    expect(isNumeric(COLUMNS, 1, FIRST)).toBe(false);
    expect(isNumeric(COLUMNS, 2, FIRST)).toBe(true);
    expect(isNumeric(COLUMNS, 3, FIRST)).toBe(true);
  });

  it('drops the pages farthest from the view', () => {
    expect(pagesToDrop([0, 1, 2, 50, 51], 51, 3)).toEqual([0, 1]);
    expect(pagesToDrop([0, 1], 0, 3)).toEqual([]);
  });
});

describe('WindowAreaModel', () => {
  it('answers from the first rows and numbers the rows', () => {
    const s = store(3);
    const loaded = vi.fn();
    const model = new WindowAreaModel(s.fetch, loaded, [
      [0, 'row 0'],
      [1, null],
    ]);
    model.setRowCount(2);
    expect(model.getRowCount()).toBe(2);
    expect(model.getValueAt(0, 0)).toBe(1);
    expect(model.getValueAt(0, 1)).toBe(0);
    expect(model.getValueAt(0, 2)).toBe('row 0');
    expect(model.getValueAt(1, 2)).toBeNull();
    expect(s.asked).toEqual([]);
  });

  it('fetches a page once, shows it when it arrives and repaints', async () => {
    const s = store(1_000_000);
    const loaded = vi.fn();
    const model = new WindowAreaModel(s.fetch, loaded, []);
    model.setRowCount(1_000_000);
    const row = 500_123;
    expect(model.getValueAt(row, 2)).toBe('');
    // every cell of the page asks, the page is fetched once
    expect(model.getValueAt(row + 1, 1)).toBe('');
    expect(s.asked).toEqual([Math.floor(row / PAGE_ROWS) * PAGE_ROWS]);
    await s.flush();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(model.getValueAt(row, 2)).toBe(`row ${row}`);
    expect(model.getValueAt(row, 0)).toBe(row + 1);
  });

  it('keeps a bounded number of pages, the ones near the view', async () => {
    const s = store(10_000_000);
    const model = new WindowAreaModel(s.fetch, () => undefined, []);
    model.setRowCount(10_000_000);
    for (let page = 0; page < MAX_PAGES + 20; page++) {
      model.getValueAt(page * PAGE_ROWS, 1);
      await s.flush();
    }
    expect(model.has(0)).toBe(false);
    expect(model.has(MAX_PAGES + 19)).toBe(true);
    expect(model.has(21)).toBe(true);
  });

  it('reads a short last page again when the result has grown', async () => {
    const s = store(50);
    const loaded = vi.fn();
    const model = new WindowAreaModel(
      s.fetch,
      loaded,
      Array.from({ length: 50 }, (_, i) => [i, `row ${i}`]),
    );
    model.setRowCount(50);
    expect(model.getValueAt(49, 2)).toBe('row 49');
    // the statement read on: 300 rows by now
    const more = store(300);
    const grown = new WindowAreaModel(
      more.fetch,
      loaded,
      Array.from({ length: 50 }, (_, i) => [i, `row ${i}`]),
    );
    grown.setRowCount(50);
    grown.setRowCount(300);
    expect(grown.getValueAt(120, 2)).toBe('');
    await more.flush();
    expect(grown.getValueAt(120, 2)).toBe('row 120');
  });

  it('asks nothing more once it is disposed and survives a result that is gone', async () => {
    const gone = () => Promise.reject({ code: 'unknown_result', message: 'x' });
    const model = new WindowAreaModel(gone, () => undefined, []);
    model.setRowCount(10);
    expect(model.getValueAt(1, 1)).toBe('');
    await Promise.resolve();
    await Promise.resolve();
    expect(model.getValueAt(1, 1)).toBe('');
    const s = store(10);
    const disposed = new WindowAreaModel(s.fetch, () => undefined, []);
    disposed.setRowCount(10);
    disposed.dispose();
    disposed.getValueAt(1, 1);
    expect(s.asked).toEqual([]);
  });
});

describe('resultModel', () => {
  it('builds a table model: the row number fixed left, then one column per result column', () => {
    const body = new WindowAreaModel(store(3).fetch, () => undefined, FIRST);
    body.setRowCount(3);
    const model = resultModel(COLUMNS, FIRST, body, 3);
    expect(model.getColumnCount()).toBe(5);
    expect(model.getFixedLeftColumnCount()).toBe(1);
    expect(model.getBodyModel().getRowCount()).toBe(3);
    expect(model.getBodyModel().getValueAt(0, 2)).toBe('Ada Lovelace');
    expect(model.getBodyModel().getRowHeight(0)).toBe(22);
  });
});
