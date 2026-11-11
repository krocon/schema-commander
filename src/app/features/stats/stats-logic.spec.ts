import { describe, expect, it } from 'vitest';
import { EMPTY_STATS } from '../../../testing/fake-apis';
import { DEFAULT_SETTINGS } from '../../core/settings/settings.models';
import {
  DEFAULT_MEASURES,
  figuresOf,
  shareText,
  shownFigures,
  spanText,
  spoken,
  toggleMeasure,
} from './stats-logic';

describe('stats-logic', () => {
  const numbers = {
    ...EMPTY_STATS,
    cells: 12000,
    nonNull: 11990,
    distinct: 250,
    numbers: 11990,
    sum: '12345678901234567890.1234567890',
    mean: '1029664628960347.613',
    min: '-5',
    max: '99999',
  };

  it('shows the counts always and the figures of numbers only when there are numbers', () => {
    expect(figuresOf({ ...EMPTY_STATS, cells: 3, nonNull: 2, distinct: 2 }, false)).toEqual([
      { key: 'cells', label: 'Anzahl', shown: '3', raw: '3' },
      { key: 'nonNull', label: 'Nicht NULL', shown: '2', raw: '2' },
      { key: 'distinct', label: 'Verschiedene', shown: '2', raw: '2' },
    ]);
    expect(figuresOf(numbers, false).map((f) => f.key)).toEqual([
      'cells',
      'nonNull',
      'distinct',
      'sum',
      'mean',
      'min',
      'max',
    ]);
  });

  it('groups digits for the eye and never in what is copied', () => {
    const sum = figuresOf(numbers, true).find((f) => f.key === 'sum')!;
    expect(sum.raw).toBe('12345678901234567890.1234567890');
    expect(sum.shown).not.toBe(sum.raw);
    expect(sum.shown.replace(/[^\d.]/g, '')).toBe(sum.raw);
    expect(figuresOf(numbers, false).find((f) => f.key === 'sum')!.shown).toBe(sum.raw);
  });

  it('says when there are more different values than were counted', () => {
    const f = figuresOf({ ...numbers, distinct: 5_000_000, distinctCapped: true }, false);
    expect(f.find((x) => x.key === 'distinct')!.shown).toBe('mehr als 5000000');
  });

  it('shows first, last and span of dates, and the lengths of texts', () => {
    const dates = figuresOf(
      {
        ...EMPTY_STATS,
        cells: 2,
        first: '2024-02-29',
        last: '2026-03-01',
        spanMs: 731 * 86_400_000,
      },
      false,
    );
    expect(dates.slice(3).map((f) => [f.key, f.shown])).toEqual([
      ['first', '2024-02-29'],
      ['last', '2026-03-01'],
      ['span', '731 Tage'],
    ]);
    const texts = figuresOf({ ...EMPTY_STATS, cells: 2, shortest: 0, longest: 6 }, false);
    expect(texts.slice(3).map((f) => [f.key, f.shown, f.raw])).toEqual([
      ['shortest', '0 Zeichen', '0'],
      ['longest', '6 Zeichen', '6'],
    ]);
  });

  it('writes a span as days and a clock', () => {
    expect(spanText(0)).toBe('00:00:00');
    expect(spanText(1500)).toBe('00:00:01.500');
    expect(spanText(86_400_000)).toBe('1 Tag');
    expect(spanText(86_400_000 + 3_723_000)).toBe('1 Tag 01:02:03');
    expect(spanText((24 * 60 + 30) * 60_000)).toBe('1 Tag 00:30:00');
  });

  it('keeps to the chosen figures, in the fixed order', () => {
    const all = figuresOf(numbers, false);
    expect(shownFigures(all, DEFAULT_MEASURES).map((f) => f.key)).toEqual([
      'cells',
      'sum',
      'mean',
      'min',
      'max',
    ]);
    expect(shownFigures(all, ['max', 'first']).map((f) => f.key)).toEqual(['max']);
    expect(toggleMeasure(['max', 'cells'], 'distinct', true)).toEqual(['cells', 'distinct', 'max']);
    expect(toggleMeasure(['max', 'cells'], 'max', false)).toEqual(['cells']);
    // the default of the setting is the default here
    expect(DEFAULT_SETTINGS.statsMeasures).toEqual(DEFAULT_MEASURES);
  });

  it('makes one sentence for a screen reader and a share in percent', () => {
    const shown = shownFigures(figuresOf({ ...numbers, ignored: 2 }, false), ['cells', 'min']);
    expect(spoken(shown, 2)).toBe('Anzahl 12000, Min -5, 2 Zellen sind keine Zahlen');
    expect(shareText(1, 8, 'de-DE')).toBe('12,5 %');
    expect(shareText(1, 0, 'de-DE')).toBe('');
  });
});
