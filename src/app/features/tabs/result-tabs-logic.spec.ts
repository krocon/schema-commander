import { CompareReport } from '../../core/sql/query.models';
import {
  KeptResult,
  MAX_UNPINNED,
  afterClose,
  bytesText,
  compareRun,
  isKept,
  keptOverRun,
  nextKey,
  resultTitle,
  storeIds,
  subTabs,
} from './result-tabs-logic';
import { StatementRun } from './run-state';

const run = (sql: string, resultId: number | null, over: Partial<StatementRun> = {}) =>
  ({
    sql,
    kind: 'done',
    result: resultId === null ? null : { resultId, columns: [] },
    rows: resultId === null ? null : 3,
    rowsAffected: null,
    truncated: false,
    message: null,
    elapsedMs: 1,
    ...over,
  }) as StatementRun;

const kept = (n: number, pinned: boolean, over: Partial<KeptResult> = {}): KeptResult => ({
  key: `k${n}`,
  title: null,
  pinned,
  run: run(`select * from t${n}`, 100 + n),
  ...over,
});

const report = (over: Partial<CompareReport> = {}): CompareReport => ({
  resultId: 50,
  columns: [],
  rows: 10,
  diffId: 51,
  diffRows: 4,
  leftRows: 8,
  rightRows: 8,
  same: 6,
  changed: 1,
  leftOnly: 1,
  rightOnly: 1,
  duplicateLeft: 0,
  duplicateRight: 0,
  duplicateKeys: [],
  changedByColumn: [],
  leftColumnsOnly: [],
  rightColumnsOnly: [],
  byPosition: false,
  cut: false,
  ...over,
});

describe('result tabs', () => {
  it('calls a result after its table, else after how its statement begins', () => {
    expect(resultTitle('select * from "shop"."Kunden" where id = 1')).toBe('shop.Kunden');
    expect(resultTitle('select\n   1 + 1')).toBe('select 1 + 1');
    expect(resultTitle('select 1234567890 + 1234567890 + 1234567890')).toBe(
      'select 1234567890 + 1234…',
    );
  });

  it('lists the kept results first, and no statement whose result was taken over', () => {
    const tabs = subTabs(
      [
        run('select 1', 1),
        run('select 2', null, { moved: true }),
        run('x', null, { kind: 'failed' }),
      ],
      [kept(1, true, { title: 'Stand Montag' }), kept(2, false)],
      (l, r) => `${l} ↔ ${r}`,
    );
    expect(tabs.map((t) => [t.target, t.title, t.pinned, t.kind])).toEqual([
      ['k1', 'Stand Montag', true, 'done'],
      ['k2', 't2', false, 'done'],
      [0, 'select 1', false, 'done'],
      [2, 'x', false, 'failed'],
    ]);
    expect(tabs[0].rows).toBe(3);
    expect(tabs[3].rows).toBeNull();
  });

  it('names a comparison after its two sides', () => {
    const view = { report: report(), onlyDifferences: true, leftTitle: 'alt', rightTitle: 'neu' };
    const tabs = subTabs(
      [],
      [kept(1, true, { compare: view, run: compareRun('', view) })],
      (l, r) => `${l} ↔ ${r}`,
    );
    expect(tabs[0]).toMatchObject({ title: 'alt ↔ neu', compare: true, rows: 4 });
  });

  it('drops what is not pinned when a run starts', () => {
    const all = [kept(1, true), kept(2, false), kept(3, true), kept(4, false)];
    const over = keptOverRun(all, false);
    expect(over.kept.map((k) => k.key)).toEqual(['k1', 'k3']);
    expect(over.dropped.map((k) => k.key)).toEqual(['k2', 'k4']);
  });

  it('keeps everything with „always new tabs“ – up to a limit, the oldest go', () => {
    const all = [
      kept(1, true),
      ...Array.from({ length: MAX_UNPINNED + 2 }, (_, i) => kept(10 + i, false)),
    ];
    const over = keptOverRun(all, true);
    expect(over.dropped.map((k) => k.key)).toEqual(['k10', 'k11']);
    expect(over.kept.length).toBe(MAX_UNPINNED + 1);
    expect(over.kept[0].key).toBe('k1');
  });

  it('knows what a kept result holds in the store', () => {
    expect(storeIds(kept(1, true))).toEqual([101]);
    const view = { report: report(), onlyDifferences: true, leftTitle: 'a', rightTitle: 'b' };
    // the view goes with its result
    expect(storeIds(kept(2, true, { compare: view, run: compareRun('', view) }))).toEqual([50]);
  });

  it('shows all rows of a comparison or only those that differ', () => {
    const view = { report: report(), onlyDifferences: false, leftTitle: 'a', rightTitle: 'b' };
    expect(compareRun('', view)).toMatchObject({ rows: 10, result: { resultId: 50 } });
    expect(compareRun('', { ...view, onlyDifferences: true })).toMatchObject({
      rows: 4,
      result: { resultId: 51 },
    });
  });

  it('goes to the neighbour of a tab that is closed', () => {
    const tabs = subTabs([run('a', 1), run('b', 2)], [kept(1, true), kept(2, true)], () => '');
    expect(afterClose(tabs, 'k1')).toBe('k2');
    expect(afterClose(tabs, 'k2')).toBe(0);
    expect(
      afterClose(
        subTabs([], [kept(1, true)], () => ''),
        'k1',
      ),
    ).toBe('messages');
  });

  it('finds a free key and tells keys from statements', () => {
    expect(nextKey([kept(1, true), kept(2, true)], 0)).toBe('k3');
    expect(nextKey([], 7)).toBe('k8');
    expect(isKept('k3')).toBe(true);
    expect(isKept('messages')).toBe(false);
    expect(isKept(0)).toBe(false);
  });

  it('writes sizes for people', () => {
    expect(bytesText(0, 'de')).toBe('0 B');
    expect(bytesText(1536, 'de')).toBe('1,5 KB');
    expect(bytesText(5 * 1024 * 1024, 'en')).toBe('5.0 MB');
    expect(bytesText(300 * 1024 * 1024, 'en')).toBe('300 MB');
  });
});
