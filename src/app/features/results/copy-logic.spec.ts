import {
  ASK_FROM_CELLS,
  COPY_FORMATS,
  bigCopyQuestion,
  copiedMessage,
  isCopyFormat,
  orderedFormats,
  selectionOf,
  selectionSize,
  tableOf,
  localTsv,
} from './copy-logic';

describe('selectionOf', () => {
  it('takes nothing selected and everything selected as the whole result', () => {
    expect(selectionOf([], false, 5)).toEqual({ rows: [], columns: [] });
    expect(selectionOf([{ r1: 1, c1: 1, r2: 2, c2: 2 }], true, 5)).toEqual({
      rows: [],
      columns: [],
    });
  });

  it('shifts the columns by the row number column', () => {
    expect(selectionOf([{ r1: 2, c1: 2, r2: 6, c2: 3 }], false, 5)).toEqual({
      rows: [[2, 6]],
      columns: [1, 2],
    });
  });

  it('means whole rows when the row number is in the range', () => {
    expect(selectionOf([{ r1: 3, c1: 0, r2: 3, c2: 0 }], false, 5)).toEqual({
      rows: [[3, 3]],
      columns: [],
    });
    expect(selectionOf([{ r1: 3, c1: 0, r2: 4, c2: 99 }], false, 5).columns).toEqual([]);
  });

  it('joins several ranges: their rows, and the columns of all of them', () => {
    expect(
      selectionOf(
        [
          { r1: 9, c1: 4, r2: 7, c2: 4 },
          { r1: 1, c1: 1, r2: 1, c2: 2 },
        ],
        false,
        5,
      ),
    ).toEqual({
      rows: [
        [7, 9],
        [1, 1],
      ],
      columns: [0, 1, 3],
    });
  });

  it('keeps a column range inside the result', () => {
    expect(selectionOf([{ r1: 0, c1: 4, r2: 0, c2: 4000 }], false, 5).columns).toEqual([3, 4]);
  });
});

describe('selectionSize', () => {
  it('counts rows and cells', () => {
    expect(selectionSize({ rows: [], columns: [] }, 1000, 5)).toEqual({ rows: 1000, cells: 5000 });
    expect(selectionSize({ rows: [[2, 6]], columns: [1, 2] }, 1000, 5)).toEqual({
      rows: 5,
      cells: 10,
    });
    expect(selectionSize({ rows: [[990, 5000]], columns: [] }, 1000, 5).rows).toBe(10);
    expect(selectionSize({ rows: [], columns: [] }, 0, 5)).toEqual({ rows: 0, cells: 0 });
  });

  it('asks from a million cells on', () => {
    const big = selectionSize({ rows: [], columns: [] }, 2_000_000, 20);
    expect(big.cells).toBeGreaterThan(ASK_FROM_CELLS);
    expect(bigCopyQuestion(big.rows, big.cells)).toContain('2 000 000 Zeilen');
  });
});

describe('formats', () => {
  it('puts the one used last on top and keeps all nine', () => {
    expect(orderedFormats(null)).toBe(COPY_FORMATS);
    const ordered = orderedFormats('json');
    expect(ordered[0].id).toBe('json');
    expect(ordered).toHaveLength(9);
    expect(new Set(ordered.map((f) => f.id)).size).toBe(9);
  });

  it('knows its formats', () => {
    expect(isCopyFormat('inlist')).toBe(true);
    expect(isCopyFormat('xml')).toBe(false);
    expect(isCopyFormat(null)).toBe(false);
  });

  it('says what was copied', () => {
    expect(copiedMessage({ rows: 1, columns: 2, chars: 9 }, 'tsv')).toBe('1 Zeile kopiert (TSV)');
    expect(copiedMessage({ rows: 12345, columns: 2, chars: 9 }, 'insert')).toBe(
      '12 345 Zeilen kopiert (INSERT-Anweisungen)',
    );
  });
});

describe('tableOf', () => {
  it('finds the one table of a statement, as it is written', () => {
    expect(tableOf('SELECT * FROM orders LIMIT 200;')).toBe('orders');
    expect(tableOf('select a, b\nfrom shop . "Order Items" where a > 1')).toBe(
      'shop."Order Items"',
    );
    expect(tableOf('SELECT TOP 5 * FROM [dbo].[my table]')).toBe('[dbo].[my table]');
    expect(tableOf('SELECT * FROM `größe` -- from other')).toBe('`größe`');
  });

  it('finds none where there is more than one or none at all', () => {
    expect(tableOf('SELECT 1')).toBeNull();
    expect(tableOf('SELECT * FROM a JOIN b ON a.id = b.id')).toBeNull();
    expect(tableOf('SELECT * FROM a, b')).toBeNull();
    expect(tableOf('SELECT * FROM a WHERE x IN (SELECT y FROM b)')).toBeNull();
  });

  it('copies rows that live in the page, tab-separated', () => {
    const rows = [
      ['id', 'integer', null],
      ['note', 'text\twith a tab', 'two\nlines'],
      ['x', 'y', 'z'],
    ];
    // nothing selected: everything
    expect(localTsv(rows, { rows: [], columns: [] })).toBe(
      'id\tinteger\t\nnote\ttext with a tab\ttwo lines\nx\ty\tz',
    );
    // a range of rows, some columns
    expect(localTsv(rows, { rows: [[1, 2]], columns: [0, 2] })).toBe('note\ttwo lines\nx\tz');
    // a range beyond the end stops at the end
    expect(localTsv(rows, { rows: [[2, 99]], columns: [] })).toBe('x\ty\tz');
    expect(localTsv([], { rows: [], columns: [] })).toBe('');
  });
});
