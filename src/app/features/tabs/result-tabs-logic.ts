/**
 * The results of a tab as sub-tabs (prompt 041): those of the last run, and the ones that are kept beyond
 * a run – pinned by the user, or the outcome of a comparison. Pure.
 */
import { CompareReport } from '../../core/sql/query.models';
import { tableOf } from '../results/copy-logic';
import { StatementRun } from './run-state';

/** The key of a kept result: `k1`, `k2` … */
export type KeptKey = `k${number}`;
/** What the result area of a tab shows: a statement of the last run, a kept result, or the messages. */
export type Shown = number | 'messages' | KeptKey;

export const isKept = (shown: Shown): shown is KeptKey =>
  typeof shown === 'string' && shown !== 'messages';

/** A comparison of two results: its report, and whether only the rows that differ are shown. */
export interface CompareView {
  readonly report: CompareReport;
  readonly onlyDifferences: boolean;
  readonly leftTitle: string;
  readonly rightTitle: string;
}

/** A result that outlives the run it came from. */
export interface KeptResult {
  readonly key: KeptKey;
  /** The name the user gave it; `null` = from its statement. */
  readonly title: string | null;
  /** Pinned: stays until it is closed. Not pinned: goes with the next run (or with the limit). */
  readonly pinned: boolean;
  /** The statement with its result (`kind: 'done'`). */
  readonly run: StatementRun;
  readonly compare?: CompareView;
}

/** Kept results that are not pinned a tab holds at most (setting „always a new tab“); older ones go. */
export const MAX_UNPINNED = 20;
const TITLE_CHARS = 24;

/** What a result is called: its table, else how its statement begins. */
export function resultTitle(sql: string): string {
  const table = tableOf(sql)?.replace(/["`[\]]/g, '');
  if (table) return table.length > TITLE_CHARS ? `${table.slice(0, TITLE_CHARS)}…` : table;
  const line = sql.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}…` : line;
}

/** A sub-tab of the result area. */
export interface SubTab {
  readonly target: Shown;
  readonly title: string;
  /** The whole statement, for the tooltip. */
  readonly sql: string;
  readonly rows: number | null;
  readonly kind: StatementRun['kind'];
  readonly pinned: boolean;
  readonly kept: boolean;
  readonly compare: boolean;
}

/**
 * The sub-tabs in their order: the kept results first (the oldest first), then the statements of the last
 * run. A statement whose result was taken over into the kept ones has no tab of its own.
 */
export function subTabs(
  runs: readonly StatementRun[],
  kept: readonly KeptResult[],
  compareTitle: (left: string, right: string) => string,
): SubTab[] {
  const tabs: SubTab[] = kept.map((k) => ({
    target: k.key,
    title:
      k.title ??
      (k.compare
        ? compareTitle(k.compare.leftTitle, k.compare.rightTitle)
        : resultTitle(k.run.sql)),
    sql: k.run.sql,
    rows: k.run.rows,
    kind: 'done',
    pinned: k.pinned,
    kept: true,
    compare: !!k.compare,
  }));
  runs.forEach((run, index) => {
    if (run.moved) return;
    tabs.push({
      target: index,
      title: run.title ?? resultTitle(run.sql),
      sql: run.sql,
      rows: run.result ? run.rows : null,
      kind: run.kind,
      pinned: false,
      kept: false,
      compare: false,
    });
  });
  return tabs;
}

/** The kept results after a run started: what is not pinned goes – unless every run gets new tabs. */
export function keptOverRun(
  kept: readonly KeptResult[],
  keepAll: boolean,
): { kept: KeptResult[]; dropped: KeptResult[] } {
  if (!keepAll) {
    return { kept: kept.filter((k) => k.pinned), dropped: kept.filter((k) => !k.pinned) };
  }
  const loose = kept.filter((k) => !k.pinned);
  const dropped = loose.slice(0, Math.max(0, loose.length - MAX_UNPINNED));
  return { kept: kept.filter((k) => !dropped.includes(k)), dropped };
}

/** The ids a kept result holds in the store (a view goes with its result). */
export function storeIds(kept: KeptResult): number[] {
  if (kept.compare) return [kept.compare.report.resultId];
  return kept.run.result ? [kept.run.result.resultId] : [];
}

/** Where to look after a sub-tab went: its neighbour, else the messages. */
export function afterClose(tabs: readonly SubTab[], closed: Shown): Shown {
  const at = tabs.findIndex((t) => t.target === closed);
  const rest = tabs.filter((t) => t.target !== closed);
  if (rest.length === 0) return 'messages';
  return rest[Math.min(Math.max(at, 0), rest.length - 1)].target;
}

/** The next key that is free. */
export function nextKey(kept: readonly KeptResult[], last: number): KeptKey {
  const used = new Set(kept.map((k) => k.key));
  let n = last + 1;
  while (used.has(`k${n}`)) n++;
  return `k${n}`;
}

/** The run of a comparison as the result area shows it: all rows, or only those that differ. */
export function compareRun(sql: string, view: CompareView): StatementRun {
  const { report } = view;
  return {
    sql,
    kind: 'done',
    result: {
      resultId: view.onlyDifferences ? report.diffId : report.resultId,
      columns: [...report.columns],
    },
    rows: view.onlyDifferences ? report.diffRows : report.rows,
    rowsAffected: null,
    truncated: report.cut,
    message: null,
    elapsedMs: 0,
  };
}

/** `1.5 MB`: what results take, with the decimal sign of `locale`. */
export function bytesText(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`;
}
