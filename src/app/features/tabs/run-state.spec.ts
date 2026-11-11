import { clock, firstLine, outcomeText, pending, runStatus, stateOf } from './run-state';

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
  });

  it('shortens a statement to its first line that is no comment', () => {
    expect(firstLine('-- Kopf\n\n  select *\n  from t')).toBe('select *');
    expect(firstLine('-- nur Kommentar')).toBe('-- nur Kommentar');
    expect([...firstLine('x'.repeat(500))].length).toBe(120);
  });

  it('formats a time of day', () => {
    expect(clock(new Date(2024, 0, 1, 9, 5, 7).getTime())).toBe('09:05:07');
  });
});
