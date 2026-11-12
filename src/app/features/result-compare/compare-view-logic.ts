/** Looking at the comparison of two results (prompt 041). Pure. */
import {
  COMPARE_EXTRA_COLUMNS,
  COMPARE_STATES,
  ColumnPairing,
  CompareReport,
  CompareSpec,
  QueryColumn,
} from '../../core/sql/query.models';
import type { RowTint } from '../results/result-model';

/**
 * The classes of the rows of a comparison: a row that is on one side only in the colour of that side, of
 * a changed row the cells that differ, and a line under rows whose key is not unique. `columns`: the names
 * of the columns of the outcome.
 */
export function compareTint(columns: readonly string[]): RowTint {
  const S = COMPARE_STATES;
  return (cell, column) => {
    const state = cell(0);
    if (typeof state !== 'string' || state === S.same) return null;
    if (state === S.onlyLeft) return 'sc-diff-left';
    if (state === S.onlyRight) return 'sc-diff-right';
    if (state === S.duplicateLeft || state === S.duplicateRight) return 'sc-diff-duplicate';
    if (state !== S.changedLeft && state !== S.changedRight) return null;
    // the state itself in the colour of its side, so the pair reads as before and after
    const side = state === S.changedLeft ? 'sc-diff-left' : 'sc-diff-right';
    if (column < COMPARE_EXTRA_COLUMNS) return column === 0 ? side : null;
    const changed = cell(1);
    return typeof changed === 'string' && namesIn(changed, columns[column] ?? '')
      ? 'sc-diff-changed'
      : null;
  };
}

/** Whether `name` is one of the names in `list` (joined with `, ` by the backend). */
export function namesIn(list: string, name: string): boolean {
  return (
    list === name ||
    list.startsWith(`${name}, `) ||
    list.endsWith(`, ${name}`) ||
    list.includes(`, ${name}, `)
  );
}

/** What the dialog asks for. Columns are those of the left result. */
export interface CompareChoice {
  /** `false`: rows go together by their position. */
  readonly byKey: boolean;
  readonly keys: readonly number[];
  readonly ignore: readonly number[];
  readonly trim: boolean;
  readonly ignoreCase: boolean;
  /** Round numbers before comparing them. */
  readonly round: boolean;
  readonly decimals: number;
}

export const MAX_DECIMALS = 15;

/**
 * The keys to start with: the columns that were the key the last time (by name), else a column that
 * looks like one (`id`, `…_id`, `…id`), else the first one.
 */
export function suggestKeys(
  pairing: ColumnPairing,
  left: readonly QueryColumn[],
  remembered: readonly string[],
): number[] {
  const paired = pairing.pairs.map((p) => p[0]);
  if (paired.length === 0) return [];
  const known = paired.filter((c) => remembered.includes(left[c]?.name.toLowerCase() ?? ''));
  if (remembered.length > 0 && known.length === remembered.length) return known;
  const id = paired.find((c) => /^(id|.*_id|.*Id)$/.test(left[c]?.name ?? ''));
  return [id ?? paired[0]];
}

/** The choice of the dialog as the backend wants it. */
export function specOf(left: number, right: number, choice: CompareChoice): CompareSpec {
  const keys = choice.byKey ? [...choice.keys] : [];
  return {
    left,
    right,
    keys,
    ignore: choice.ignore.filter((c) => !keys.includes(c)),
    trim: choice.trim,
    ignoreCase: choice.ignoreCase,
    decimals: choice.round
      ? Math.min(MAX_DECIMALS, Math.max(0, Math.trunc(choice.decimals) || 0))
      : null,
  };
}

/** Why a choice cannot be compared; `null` = it can. */
export function choiceProblem(
  choice: CompareChoice,
  pairing: ColumnPairing | null,
  sameResult: boolean,
): 'same' | 'noColumns' | 'noKey' | null {
  if (sameResult) return 'same';
  if (!pairing || pairing.pairs.length === 0) return 'noColumns';
  if (choice.byKey && choice.keys.length === 0) return 'noKey';
  return null;
}

/** A figure of the summary. */
export interface Figure {
  readonly key: 'same' | 'changed' | 'leftOnly' | 'rightOnly' | 'duplicates';
  readonly count: number;
}

/** The figures of a comparison, those that are zero too (duplicates only when there are some). */
export function figures(report: CompareReport): Figure[] {
  const out: Figure[] = [
    { key: 'same', count: report.same },
    { key: 'changed', count: report.changed },
    { key: 'leftOnly', count: report.leftOnly },
    { key: 'rightOnly', count: report.rightOnly },
  ];
  const duplicates = report.duplicateLeft + report.duplicateRight;
  if (duplicates > 0) out.push({ key: 'duplicates', count: duplicates });
  return out;
}

/** Whether the two results are the same, as far as they were compared. */
export function identical(report: CompareReport): boolean {
  return report.diffRows === 0 && !report.cut;
}
