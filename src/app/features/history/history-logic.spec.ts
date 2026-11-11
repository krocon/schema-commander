import {
  durationLabel,
  mayRecall,
  oneLine,
  outcomeLabel,
  recallStep,
  whenLabel,
} from './history-logic';

describe('history labels', () => {
  it('shows the time today and the date before', () => {
    const now = new Date(2026, 10, 11, 15, 0, 0).getTime();
    expect(whenLabel(new Date(2026, 10, 11, 9, 5, 7).getTime(), now)).toBe('09:05:07');
    expect(whenLabel(new Date(2026, 10, 10, 23, 59, 59).getTime(), now)).toBe(
      '2026-11-10 23:59:59',
    );
  });

  it('shortens durations', () => {
    expect(durationLabel(0)).toBe('0 ms');
    expect(durationLabel(999)).toBe('999 ms');
    expect(durationLabel(1234)).toBe('1,23 s');
    expect(durationLabel(45_600)).toBe('45,6 s');
    expect(durationLabel(125_000)).toBe('2 min 5 s');
  });

  it('puts a statement on one line', () => {
    expect(oneLine('SELECT a,\n       b\n  FROM t')).toBe('SELECT a, b FROM t');
    expect(oneLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('says how an entry ended', () => {
    expect(outcomeLabel({ outcome: 'ok', rows: 1 })).toBe('1 Zeile');
    expect(outcomeLabel({ outcome: 'ok', rows: 250 })).toBe('250 Zeilen');
    expect(outcomeLabel({ outcome: 'ok', rows: null })).toBe('ok');
    expect(outcomeLabel({ outcome: 'failed', rows: null })).toBe('Fehler');
    expect(outcomeLabel({ outcome: 'cancelled', rows: 3 })).toBe('abgebrochen');
  });
});

describe('recall', () => {
  it('steps back in time and forth, and stops at both ends', () => {
    expect(recallStep(-1, 1, 3)).toBe(0);
    expect(recallStep(0, 1, 3)).toBe(1);
    expect(recallStep(2, 1, 3)).toBe(2);
    expect(recallStep(1, -1, 3)).toBe(0);
    expect(recallStep(0, -1, 3)).toBe(-1);
    expect(recallStep(-1, -1, 3)).toBe(-1);
    expect(recallStep(-1, 1, 0)).toBe(-1);
  });

  it('never overwrites what was typed', () => {
    expect(mayRecall('', null)).toBe(true);
    expect(mayRecall('  \n', null)).toBe(true);
    expect(mayRecall('SELECT 1', null)).toBe(false);
    expect(mayRecall('SELECT 1\n', 'SELECT 1')).toBe(true);
    expect(mayRecall('SELECT 1 -- changed', 'SELECT 1')).toBe(false);
  });
});
