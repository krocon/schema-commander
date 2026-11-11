import { Loaded } from '../../core/import/data-import-api';
import {
  DEFAULT_CHOICES,
  MapRow,
  autoMap,
  ddlColumns,
  detectedLine,
  nullTexts,
  planOf,
  remap,
  reportLine,
  sourceOptions,
  tableNameOf,
  targetKind,
  unfilled,
} from './data-import-logic';

const col = (
  name: string,
  typeName: string,
  nullable = true,
  def: string | null = null,
): MapRow['target'] => ({ name, typeName, nullable, default: def, key: '' });

describe('data import logic', () => {
  it('says how the file is read: what is not chosen is detected', () => {
    expect(sourceOptions(DEFAULT_CHOICES)).toEqual({
      format: 'auto',
      delimiter: null,
      quote: null,
      encoding: null,
      header: null,
      skipLines: 0,
    });
    expect(
      sourceOptions({
        ...DEFAULT_CHOICES,
        format: 'csv',
        delimiter: '\t',
        encoding: 'windows-1252',
        header: 'no',
        skipLines: 2.7,
      }),
    ).toEqual({
      format: 'csv',
      delimiter: '\t',
      quote: null,
      encoding: 'windows-1252',
      header: false,
      skipLines: 2,
    });
    expect(sourceOptions({ ...DEFAULT_CHOICES, skipLines: -3 }).skipLines).toBe(0);
    expect(nullTexts(' NULL, \\N ,, NULL,n/a')).toEqual(['NULL', '\\N', 'n/a']);
  });

  it('binds a value by the type of its column', () => {
    for (const t of [
      'integer',
      'bigint',
      'INT4',
      'numeric(12,2)',
      'decimal(38, 10)',
      'double precision',
      'smallint',
      'tinyint(4)',
      'money',
    ]) {
      expect(targetKind(t), t).toBe('number');
    }
    for (const t of ['boolean', 'bool', 'bit', 'tinyint(1)']) expect(targetKind(t), t).toBe('bool');
    for (const t of [
      'text',
      'character varying(20)',
      'date',
      'interval',
      'uuid',
      'bit(8)',
      'point',
    ]) {
      expect(targetKind(t), t).toBe('text');
    }
  });

  it('maps columns by name, whatever their case and punctuation, else by position', () => {
    const table = [col('id', 'integer'), col('order_total', 'numeric'), col('note', 'text')];
    expect(autoMap(['Note', 'Order Total', 'ID', 'more'], table).map((m) => m.source)).toEqual([
      2, 1, 0,
    ]);
    expect(autoMap(['id', 'zzz'], table).map((m) => m.source)).toEqual([0, 'none', 'none']);
    // a file without a header: column_1 … – no name fits
    expect(autoMap(['column_1', 'column_2'], table).map((m) => m.source)).toEqual([0, 1, 'none']);
    expect(autoMap([], table).every((m) => m.source === 'none')).toBe(true);
    // read again with fewer columns: what pointed behind the end points nowhere
    const old: MapRow[] = [
      { target: table[0], source: 3, fixed: '' },
      { target: table[1], source: 'fixed', fixed: 'x' },
      { target: table[2], source: 1, fixed: '' },
    ];
    expect(remap(old, 2).map((m) => m.source)).toEqual(['none', 'fixed', 1]);
  });

  it('builds the plan: unmapped columns are left out, conversions go where they fit', () => {
    const rows: MapRow[] = [
      { target: col('id', 'integer', false), source: 0, fixed: '' },
      { target: col('amount', 'numeric(12,2)'), source: 2, fixed: '' },
      { target: col('day', 'date'), source: 1, fixed: '' },
      { target: col('origin', 'text'), source: 'fixed', fixed: "it's" },
      { target: col('skipped', 'text'), source: 'none', fixed: 'ignored' },
    ];
    const plan = planOf('shop', 'orders', rows, {
      ...DEFAULT_CHOICES,
      trim: true,
      decimalComma: true,
      dateOrder: 'dmy',
      onError: 'skip',
      wholeTransaction: true,
      nullTexts: 'NULL, -',
    });
    expect(plan).toMatchObject({
      schema: 'shop',
      table: 'orders',
      nullTexts: ['NULL', '-'],
      emptyIsNull: true,
      clearFirst: false,
      onError: 'skip',
      // leaving rows out and all-or-nothing do not go together
      wholeTransaction: false,
    });
    expect(plan.mappings).toEqual([
      {
        source: 0,
        fixed: null,
        target: { name: 'id', kind: 'number', typeName: 'integer' },
        trim: true,
        decimalComma: true,
        dateOrder: null,
      },
      {
        source: 2,
        fixed: null,
        target: { name: 'amount', kind: 'number', typeName: 'numeric(12,2)' },
        trim: true,
        decimalComma: true,
        dateOrder: null,
      },
      {
        source: 1,
        fixed: null,
        target: { name: 'day', kind: 'text', typeName: 'date' },
        trim: true,
        decimalComma: false,
        dateOrder: 'dmy',
      },
      {
        source: null,
        fixed: "it's",
        target: { name: 'origin', kind: 'text', typeName: 'text' },
        trim: true,
        decimalComma: false,
        dateOrder: null,
      },
    ]);
    expect(planOf('', 't', rows, DEFAULT_CHOICES)).toMatchObject({
      schema: null,
      wholeTransaction: true,
    });
  });

  it('names the columns that must have a value and get none', () => {
    const rows: MapRow[] = [
      { target: col('id', 'integer', false), source: 'none', fixed: '' },
      { target: col('made', 'timestamp', false, 'now()'), source: 'none', fixed: '' },
      { target: col('note', 'text', true), source: 'none', fixed: '' },
      { target: col('name', 'text', false), source: 0, fixed: '' },
    ];
    expect(unfilled(rows)).toEqual(['id']);
  });

  it('proposes a table name from the file and columns from its start', () => {
    expect(tableNameOf('/data/Orders 2026 (final).csv.gz')).toBe('orders_2026_final');
    expect(tableNameOf('C:\\in\\2026-umsätze.json')).toBe('t_2026_umsätze');
    expect(tableNameOf('/x/.csv')).toBe('imported');
    expect(tableNameOf('/x/"; DROP TABLE t; --.csv')).toBe('drop_table_t');
    expect(ddlColumns(['a', 'b'], [{ kind: 'int', maxLen: 2, nullable: false }])).toEqual([
      ['a', { kind: 'int', maxLen: 2, nullable: false }],
      ['b', { kind: 'text', maxLen: 0, nullable: true }],
    ]);
  });

  it('says what was detected and how the import ended', () => {
    expect(
      detectedLine({
        format: 'csv',
        delimiter: '\t',
        encoding: 'utf-16le',
        header: true,
        gzip: true,
      }),
    ).toBe('CSV / TSV · Trenner Tabulator · mit Kopfzeile · UTF-16LE · gzip');
    expect(
      detectedLine({
        format: 'ndjson',
        delimiter: ',',
        encoding: 'utf-8',
        header: false,
        gzip: false,
      }),
    ).toBe('NDJSON (ein Objekt je Zeile) · UTF-8');
    const done: Loaded = {
      read: 1200,
      written: 1200,
      skipped: 0,
      errors: [],
      cancelled: false,
      failed: false,
      rolledBack: false,
      errorFile: false,
    };
    expect(reportLine(done)).toBe('1.200 Zeilen importiert.');
    expect(reportLine({ ...done, written: 1197, skipped: 3 })).toBe(
      '1.197 Zeilen importiert, 3 Zeilen ausgelassen.',
    );
    expect(reportLine({ ...done, written: 0, failed: true, rolledBack: true })).toContain(
      'Nichts wurde importiert',
    );
    expect(reportLine({ ...done, written: 400, failed: true })).toContain('400 Zeilen');
    expect(reportLine({ ...done, written: 0, cancelled: true, rolledBack: true })).toContain(
      'Abgebrochen. Nichts',
    );
    expect(reportLine({ ...done, written: 1, cancelled: true })).toContain('1 Zeile bis dahin');
  });
});
