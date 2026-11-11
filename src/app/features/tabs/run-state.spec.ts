import {
  clock,
  firstLine,
  outcomeText,
  pending,
  runStatus,
  stateOf,
  errorObjectText,
  errorReport,
} from './run-state';

const done = (sql: string, over = {}) => ({
  ...pending(sql),
  kind: 'done' as const,
  rows: 2,
  elapsedMs: 3,
  ...over,
});

describe('run state', () => {
  it('describes a run while it runs and when it is over', () => {
    expect(runStatus([], 0)).toBe('Bereit');
    expect(runStatus([{ ...pending('a'), kind: 'running' }], 1234)).toBe('Läuft … 1,23 s');
    expect(runStatus([done('a'), { ...pending('b'), kind: 'running' }, pending('c')], 12_340)).toBe(
      'Läuft … 12,3 s (2 von 3)',
    );
    expect(
      runStatus(
        [
          done('a'),
          { ...pending('b'), kind: 'failed', message: 'x', elapsedMs: 1500 },
          { ...pending('c'), kind: 'skipped' },
        ],
        0,
      ),
    ).toBe('3 Anweisungen · 1 ausgeführt · 1 mit Fehler · 1 nicht ausgeführt · 1,50 s');
  });

  it('says what a statement did', () => {
    expect(outcomeText(done('a'))).toBe('2 Zeilen');
    expect(outcomeText(done('a', { rows: 1_234_567 }))).toBe('1\u202f234\u202f567 Zeilen');
    expect(outcomeText(done('a', { rows: 1, truncated: true }))).toBe('1 Zeile (abgeschnitten)');
    expect(outcomeText(done('a', { rows: null, rowsAffected: 1 }))).toBe('1 Zeile geändert');
    expect(outcomeText({ ...pending('a'), kind: 'failed', message: 'boom' })).toBe('boom');
    expect(outcomeText({ ...pending('a'), kind: 'cancelled' })).toBe('Abgebrochen');
  });

  it('maps a statement to what the result area shows', () => {
    expect(stateOf(undefined).kind).toBe('idle');
    expect(stateOf(pending('a')).kind).toBe('running');
    expect(stateOf({ ...pending('a'), kind: 'skipped' }).kind).toBe('cancelled');
    // a result that was not kept says so instead of showing nothing
    expect(stateOf(done('a'))).toMatchObject({ kind: 'failed' });
    expect(stateOf(done('a', { result: { resultId: 3, columns: [] } }))).toMatchObject({
      kind: 'done',
      rows: 2,
      result: { resultId: 3 },
    });
    expect(stateOf(done('a', { rows: null, rowsAffected: 4 }))).toMatchObject({
      kind: 'done',
      result: null,
      rowsAffected: 4,
    });
    expect(
      stateOf({ ...pending('a'), kind: 'running', result: { resultId: 3, columns: [] }, rows: 9 }),
    ).toMatchObject({ kind: 'running', rows: 9 });
  });

  it('shortens a statement to its first line that is no comment', () => {
    expect(firstLine('-- Kopf\n\n  select *\n  from t')).toBe('select *');
    expect(firstLine('-- nur Kommentar')).toBe('-- nur Kommentar');
    expect([...firstLine('x'.repeat(500))].length).toBe(120);
  });

  it('formats a time of day', () => {
    expect(clock(new Date(2024, 0, 1, 9, 5, 7).getTime())).toBe('09:05:07');
  });

  it('writes an error as text to copy, with what the database added', () => {
    const t = {
      errorCode: 'Code',
      errorDetail: 'Detail',
      errorHint: 'Hinweis',
      errorContext: 'Kontext',
      errorObject: 'Objekt',
    };
    const details = {
      sqlstate: '23503',
      detail: 'Key (parent_id)=(7) is not present in table "parent".',
      schema: 'shop',
      table: 'child',
      constraint: 'child_fk',
    };
    expect(errorObjectText(details)).toBe('shop.child · child_fk');
    expect(errorObjectText({ column: 'a' })).toBe('a');
    expect(
      errorReport('violates foreign key (23503)', details, 'INSERT INTO child VALUES (7)', t),
    ).toBe(
      [
        'violates foreign key (23503)',
        'Code: 23503',
        'Detail: Key (parent_id)=(7) is not present in table "parent".',
        'Objekt: shop.child · child_fk',
        '',
        'INSERT INTO child VALUES (7)',
      ].join('\n'),
    );
    expect(errorReport('boom', null, 'SELECT 1', t)).toBe('boom\n\nSELECT 1');
  });
});
