import { ResultStats } from '../../core/sql/query.models';
import { groupDigits } from '../results/cell-format';
import { STATS_TEXTS } from './stats-texts';

/** The figures there are, in the order they are shown. */
export const MEASURES = [
  'cells',
  'nonNull',
  'distinct',
  'sum',
  'mean',
  'min',
  'max',
  'first',
  'last',
  'span',
  'shortest',
  'longest',
] as const;
export type Measure = (typeof MEASURES)[number];

/** What the status line shows unless the user chose otherwise (the default of the setting `statsMeasures`). */
export const DEFAULT_MEASURES: readonly Measure[] = ['cells', 'sum', 'mean', 'min', 'max'];

export const isMeasure = (key: unknown): key is Measure =>
  typeof key === 'string' && (MEASURES as readonly string[]).includes(key);

/** One figure: what it is called, how it is shown, and what a copy of it puts on the clipboard. */
export interface Figure {
  readonly key: Measure;
  readonly label: string;
  /** For the eye: digits grouped when asked for. */
  readonly shown: string;
  /** For the clipboard: the value as it is, exact. */
  readonly raw: string;
}

const two = (n: number) => String(n).padStart(2, '0');

/** Days and a clock: `3 Tage 04:05:06`, `00:00:01.500`. */
export function spanText(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const rest = abs % 86_400_000;
  const h = Math.floor(rest / 3_600_000);
  const m = Math.floor((rest % 3_600_000) / 60_000);
  const s = Math.floor((rest % 60_000) / 1000);
  const milli = rest % 1000;
  const clock = `${two(h)}:${two(m)}:${two(s)}${milli ? `.${String(milli).padStart(3, '0')}` : ''}`;
  if (days === 0) return clock;
  const d = STATS_TEXTS.days(groupDigits(String(days)));
  return rest === 0 ? d : `${d} ${clock}`;
}

/**
 * The figures a selection has: counts always, the figures of numbers when there are numbers, those of
 * dates and texts when there are such cells. `group`: digits in groups of three (never in what is copied).
 */
export function figuresOf(stats: ResultStats, group: boolean): Figure[] {
  const t = STATS_TEXTS;
  const number = (text: string) => (group ? groupDigits(text) : text);
  const out: Figure[] = [];
  const add = (key: Measure, raw: string, shown = raw) =>
    out.push({ key, label: t.labels[key], shown, raw });
  add('cells', String(stats.cells), number(String(stats.cells)));
  add('nonNull', String(stats.nonNull), number(String(stats.nonNull)));
  const distinct = number(String(stats.distinct));
  add('distinct', String(stats.distinct), stats.distinctCapped ? t.moreThan(distinct) : distinct);
  if (stats.sum !== null) add('sum', stats.sum, number(stats.sum));
  if (stats.mean !== null) add('mean', stats.mean, number(stats.mean));
  if (stats.min !== null) add('min', stats.min, number(stats.min));
  if (stats.max !== null) add('max', stats.max, number(stats.max));
  if (stats.first !== null) add('first', stats.first);
  if (stats.last !== null) add('last', stats.last);
  if (stats.spanMs !== null) add('span', spanText(stats.spanMs));
  if (stats.shortest !== null)
    add('shortest', String(stats.shortest), t.chars(number(String(stats.shortest))));
  if (stats.longest !== null)
    add('longest', String(stats.longest), t.chars(number(String(stats.longest))));
  return out;
}

/** The figures the status line shows: the chosen ones the selection has. */
export function shownFigures(figures: readonly Figure[], chosen: readonly string[]): Figure[] {
  return figures.filter((f) => chosen.includes(f.key));
}

/** One sentence for a screen reader. */
export function spoken(figures: readonly Figure[], ignored: number): string {
  const parts = figures.map((f) => `${f.label} ${f.shown}`);
  if (ignored > 0) parts.push(STATS_TEXTS.ignored(ignored));
  return parts.join(', ');
}

/** A share in percent with one digit: `12,5 %`. */
export function shareText(count: number, of: number, locale: string): string {
  if (of <= 0) return '';
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((count / of) * 100)} %`;
}

/** Adds a measure to the chosen ones or takes it away. */
export function toggleMeasure(chosen: readonly string[], key: Measure, on: boolean): Measure[] {
  return MEASURES.filter((m) => (m === key ? on : chosen.includes(m)));
}
