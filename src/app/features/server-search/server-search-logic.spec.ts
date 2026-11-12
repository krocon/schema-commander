import { FindEvent } from '../../core/find/find-api';
import {
  DEFAULT_SEARCH,
  NO_RESULTS,
  canSearch,
  detailOf,
  hitFilter,
  hitsAsTsv,
  progressLine,
  reportLine,
  skipText,
  specOf,
  withEvent,
} from './server-search-logic';

const EVENTS: FindEvent[] = [
  {
    type: 'source',
    hit: { kind: 'view', schema: 'shop', name: 'prices', line: 2, preview: 'old_price * 2' },
  },
  { type: 'start', tables: 3 },
  { type: 'table', done: 0, schema: 'shop', table: 'orders' },
  {
    type: 'rows',
    schema: 'shop',
    table: 'orders',
    hits: [{ column: 'note', preview: 'for\tmax' }],
    more: true,
  },
  { type: 'table', done: 1, schema: 'shop', table: 'photos' },
  { type: 'skipped', schema: 'shop', name: 'photos', reason: 'noColumns', message: '' },
  { type: 'table', done: 2, schema: 'shop', table: 'log' },
  { type: 'skipped', schema: 'shop', name: 'log', reason: 'large', message: '5000000' },
];

describe('server search logic', () => {
  it('says what the backend is to search', () => {
    expect(specOf({ ...DEFAULT_SEARCH, text: 'max', schemas: ['shop'] })).toEqual({
      text: 'max',
      mode: 'contains',
      caseSensitive: false,
      columns: 'text',
      schemas: ['shop'],
      tables: [],
      data: true,
      sources: true,
      names: false,
      maxHits: 20,
      tableTimeoutMs: 10_000,
      skipRowsOver: 1_000_000,
    });
    // one table: only its rows
    expect(
      specOf({ ...DEFAULT_SEARCH, text: 'x', schemas: ['shop'], names: true }, 'orders'),
    ).toMatchObject({ tables: [['shop', 'orders']], sources: false, names: false, data: true });
    // numbers that make no sense fall back
    expect(
      specOf({ ...DEFAULT_SEARCH, text: 'x', maxHits: 0, timeoutSec: -4, skipRowsOver: NaN }),
    ).toMatchObject({ maxHits: 1, tableTimeoutMs: 0, skipRowsOver: 0 });
    expect(canSearch(DEFAULT_SEARCH)).toBe(false);
    expect(canSearch({ ...DEFAULT_SEARCH, text: 'x' })).toBe(true);
    expect(canSearch({ ...DEFAULT_SEARCH, text: 'x', data: false, sources: false })).toBe(false);
  });

  it('collects what a search tells', () => {
    const r = EVENTS.reduce(withEvent, NO_RESULTS);
    expect(r.total).toBe(3);
    expect(r.tables).toEqual([
      {
        schema: 'shop',
        table: 'orders',
        hits: [{ column: 'note', preview: 'for\tmax' }],
        more: true,
      },
    ]);
    expect(r.sources.map((s) => s.name)).toEqual(['prices']);
    expect(r.skipped.map((s) => `${s.name}: ${skipText(s)}`)).toEqual([
      'photos: keine Spalte einer Art, die durchsucht wird',
      'log: etwa 5000000 Zeilen',
    ]);
    expect(progressLine(r)).toBe('Tabelle 3 von 3: shop.log');
    expect(progressLine(NO_RESULTS)).toBe('Tabellen werden gelesen …');
  });

  it('says how a search ended', () => {
    const done = {
      tables: 3,
      searched: 1,
      skipped: 0,
      rows: 1,
      sources: 2,
      cancelled: false,
      lost: false,
    };
    expect(reportLine(done)).toBe('1 Zeile, 2 Definitionen gefunden.');
    expect(reportLine({ ...done, skipped: 2 })).toBe(
      '1 Zeile, 2 Definitionen gefunden. 2 Tabellen ausgelassen.',
    );
    expect(reportLine({ ...done, cancelled: true })).toMatch(/^Abgebrochen\. 1 Zeile/);
    expect(reportLine({ ...done, lost: true })).toMatch(/^Die Verbindung ging verloren\./);
  });

  it('leads from a hit to its rows and to its definition', () => {
    // the text goes on as a value of a condition – never as SQL
    expect(hitFilter('note', "x' OR '1'='1")).toEqual({
      conditions: [
        { column: 'note', op: 'contains', values: ["x' OR '1'='1"], kind: 'number', typeName: '' },
      ],
      any: false,
      whereSql: '',
      order: [],
      limit: 1000,
    });
    const hit = (kind: string, name: string) => ({ kind, schema: 's', name, line: 1, preview: '' });
    expect(detailOf(hit('view', 'prices'))).toEqual({ name: 'prices', kind: 'view' });
    expect(detailOf(hit('routine', 'twice'))).toEqual({ name: 'twice', kind: 'routine' });
    expect(detailOf(hit('trigger', 'orders.touch'))).toEqual({ name: 'orders', kind: 'table' });
    expect(detailOf(hit('default', 'orders.price'))).toEqual({ name: 'orders', kind: 'table' });
    // MySQL names a check without its table
    expect(detailOf(hit('check', 'price_positive'))).toBeNull();
    expect(detailOf(hit('name', 'orders'))).toBeNull();
  });

  it('writes the hits as tab-separated text', () => {
    expect(hitsAsTsv(EVENTS.reduce(withEvent, NO_RESULTS))).toBe(
      'kind\tschema\tobject\tplace\ttext\n' +
        'row\tshop\torders\tnote\tfor max\n' +
        'view\tshop\tprices\t2\told_price * 2\n',
    );
  });
});
