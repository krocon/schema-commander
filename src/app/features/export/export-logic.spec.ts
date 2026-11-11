import {
  DEFAULT_CHOICES,
  EXPORT_FORMATS,
  baseName,
  doneMessage,
  fileName,
  formatHas,
  isExportFormat,
  mergeChoices,
  progressMessage,
  sizeLabel,
  specOf,
} from './export-logic';

describe('export formats', () => {
  it('knows eight formats with an extension each', () => {
    expect(EXPORT_FORMATS).toHaveLength(8);
    expect(new Set(EXPORT_FORMATS.map((f) => f.extension)).size).toBe(8);
    expect(isExportFormat('xlsx')).toBe(true);
    expect(isExportFormat('pdf')).toBe(false);
  });

  it('offers each format only what it understands', () => {
    expect(formatHas('csv')).toEqual({
      header: true,
      nullAs: true,
      delimiter: true,
      text: true,
      insert: false,
    });
    expect(formatHas('xlsx').text).toBe(false);
    expect(formatHas('json').header).toBe(false);
    expect(formatHas('insert').insert).toBe(true);
  });
});

describe('choices', () => {
  it('fall back to their defaults where they are missing or broken', () => {
    expect(mergeChoices(undefined)).toEqual(DEFAULT_CHOICES);
    expect(
      mergeChoices({ header: false, delimiter: ';', batch: 50, gzip: 'yes', nullAs: 'x' }),
    ).toEqual({
      ...DEFAULT_CHOICES,
      header: false,
      delimiter: ';',
      batch: 50,
    });
    expect(mergeChoices({ batch: 0 }).batch).toBe(500);
    expect(mergeChoices({ batch: 1e9 }).batch).toBe(10_000);
  });

  it('become a spec that leaves out what the format has not', () => {
    const all = {
      ...DEFAULT_CHOICES,
      header: false,
      nullAs: 'NULL',
      crlf: true,
      bom: true,
      gzip: true,
    };
    expect(specOf('csv', all, [0, 2], 'shop.orders', 'mysql')).toEqual({
      format: 'csv',
      options: {
        header: false,
        nullAs: 'NULL',
        delimiter: ',',
        crlf: true,
        table: 'shop.orders',
        dialect: 'mysql',
        batch: 1,
      },
      bom: true,
      gzip: true,
      columns: [0, 2],
    });
    const xlsx = specOf('xlsx', all, [], 't', 'postgres');
    expect([xlsx.bom, xlsx.gzip, xlsx.options.header]).toEqual([false, false, true]);
    const insert = specOf('insert', all, [], 't', 'postgres');
    expect([insert.options.batch, insert.bom, insert.options.crlf]).toEqual([500, false, false]);
    expect(specOf('json', all, [], 't', 'postgres').options.nullAs).toBe('');
  });
});

describe('names and messages', () => {
  it('makes a file name of what is exported', () => {
    expect(fileName('orders', 'csv', false)).toBe('orders.csv');
    expect(fileName('shop."Order Items"', 'insert', true)).toBe('shop._Order_Items.sql.gz');
    expect(fileName('größe/../etc', 'xlsx', true)).toBe('größe_.._etc.xlsx');
    expect(fileName('', 'json', false)).toBe('export.json');
    expect(fileName('..', 'json', false)).toBe('export.json');
  });

  it('takes the name of a path on every system', () => {
    expect(baseName('/Users/m/Desktop/a.csv')).toBe('a.csv');
    expect(baseName('C:\\Users\\m\\a.csv')).toBe('a.csv');
  });

  it('says how far it is and what came of it', () => {
    expect(progressMessage('a.csv', 1_234_567)).toBe(
      'Export nach a.csv: 1\u202f234\u202f567 Zeilen …',
    );
    expect(doneMessage('a.csv', { rows: 1, bytes: 12, truncated: false, cutCells: 0 })).toBe(
      '1 Zeile nach a.csv exportiert (12 B)',
    );
    expect(
      doneMessage('a.xlsx', {
        rows: 1_048_575,
        bytes: 5 * 1024 * 1024,
        truncated: true,
        cutCells: 2,
      }),
    ).toBe(
      '1\u202f048\u202f575 Zeilen nach a.xlsx exportiert (5,0 MB) – mehr Zeilen nimmt Excel nicht, der Rest fehlt – 2 Zellen gekürzt',
    );
    expect(sizeLabel(20 * 1024)).toBe('20 kB');
  });
});
