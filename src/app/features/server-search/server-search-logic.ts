import {
  FindColumns,
  FindEvent,
  FindMode,
  FindReport,
  FindSpec,
  RowHit,
  SkipReason,
  SourceHit,
} from '../../core/find/find-api';
import { ObjectKind } from '../../core/schema/schema.models';
import { TableSpec } from '../filter/filter-logic';
import { SERVER_SEARCH_TEXTS } from './server-search-texts';

/** Job ids of searches on the server: apart from exports, formatting, views, statistics, searches, imports. */
export const FIND_JOB_BASE = 6_000_000_000;
/** Hits of one table and definitions the dialog keeps (the report counts all). */
export const MAX_SHOWN = 5_000;

/** What the user chose in the dialog. */
export interface SearchChoices {
  readonly text: string;
  readonly mode: FindMode;
  readonly caseSensitive: boolean;
  readonly columns: FindColumns;
  readonly data: boolean;
  readonly sources: boolean;
  readonly names: boolean;
  /** The schemas that are ticked; none ticked = all that are not the system's. */
  readonly schemas: readonly string[];
  readonly maxHits: number;
  readonly timeoutSec: number;
  readonly skipRowsOver: number;
}

export const DEFAULT_SEARCH: SearchChoices = {
  text: '',
  mode: 'contains',
  caseSensitive: false,
  columns: 'text',
  data: true,
  sources: true,
  names: false,
  schemas: [],
  maxHits: 20,
  timeoutSec: 10,
  skipRowsOver: 1_000_000,
};

const whole = (n: number, min: number, max: number, fallback: number) =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;

/** What the backend gets. `table`: only this table of the first schema. */
export function specOf(c: SearchChoices, table: string | null = null): FindSpec {
  const schema = c.schemas[0];
  return {
    text: c.text,
    mode: c.mode,
    caseSensitive: c.caseSensitive,
    columns: c.columns,
    schemas: [...c.schemas],
    tables: table !== null && schema !== undefined ? [[schema, table]] : [],
    data: c.data,
    sources: c.sources && table === null,
    names: c.names && table === null,
    maxHits: whole(c.maxHits, 1, 1000, 20),
    tableTimeoutMs: whole(c.timeoutSec, 0, 3600, 10) * 1000,
    skipRowsOver: whole(c.skipRowsOver, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

/** Whether a search can start. */
export const canSearch = (c: SearchChoices): boolean =>
  c.text !== '' && c.text.length <= 1000 && (c.data || c.sources || c.names);

/** The rows of one table that hold the text. */
export interface TableHits {
  readonly schema: string;
  readonly table: string;
  readonly hits: readonly RowHit[];
  /** The table has more such rows than were read. */
  readonly more: boolean;
}

/** Something that was left out. */
export interface Skipped {
  readonly schema: string;
  readonly name: string;
  readonly reason: SkipReason;
  readonly message: string;
}

/** What a search has found so far. */
export interface SearchResults {
  /** Tables to search; `null` until the search knows. */
  readonly total: number | null;
  readonly done: number;
  /** The table that is being searched. */
  readonly current: string;
  readonly tables: readonly TableHits[];
  readonly sources: readonly SourceHit[];
  readonly skipped: readonly Skipped[];
}

export const NO_RESULTS: SearchResults = {
  total: null,
  done: 0,
  current: '',
  tables: [],
  sources: [],
  skipped: [],
};

/** The results with one more event of the search. */
export function withEvent(r: SearchResults, e: FindEvent): SearchResults {
  switch (e.type) {
    case 'start':
      return { ...r, total: e.tables };
    case 'table':
      return { ...r, done: e.done, current: `${e.schema}.${e.table}` };
    case 'rows':
      return r.tables.length >= MAX_SHOWN
        ? r
        : {
            ...r,
            tables: [...r.tables, { schema: e.schema, table: e.table, hits: e.hits, more: e.more }],
          };
    case 'skipped':
      if (r.skipped.length >= MAX_SHOWN) return r;
      return {
        ...r,
        skipped: [
          ...r.skipped,
          { schema: e.schema, name: e.name, reason: e.reason, message: e.message },
        ],
      };
    case 'source':
      return r.sources.length >= MAX_SHOWN ? r : { ...r, sources: [...r.sources, e.hit] };
  }
}

/** The progress in a line. */
export function progressLine(r: SearchResults): string {
  const t = SERVER_SEARCH_TEXTS;
  return r.total === null
    ? t.preparing
    : t.progress(Math.min(r.done + 1, r.total), r.total, r.current);
}

/** How a search ended, in a line. */
export function reportLine(report: FindReport): string {
  const t = SERVER_SEARCH_TEXTS;
  const found = t.found(report.rows, report.sources);
  if (report.lost) return `${t.lost} ${found}`;
  if (report.cancelled) return `${t.stopped} ${found}`;
  const more = report.moreSources ? ` ${t.moreSources}` : '';
  return (report.skipped > 0 ? `${found} ${t.leftOut(report.skipped)}` : found) + more;
}

/** Why something was left out. */
export function skipText(s: Skipped): string {
  const t = SERVER_SEARCH_TEXTS;
  switch (s.reason) {
    case 'large':
      return t.skipLarge(s.message);
    case 'noColumns':
      return t.skipNoColumns;
    case 'timeout':
      return t.skipTimeout;
    case 'refused':
      return s.message;
  }
}

/**
 * The table view that shows the rows of a hit: the column holds the text. Told as a condition – the
 * backend builds the statement and binds the text. `null`: such a search has no table view.
 */
export function hitFilter(
  column: string,
  searched: Pick<SearchChoices, 'text' | 'mode' | 'caseSensitive'>,
): TableSpec | null {
  // a regular expression is no condition of a table view
  if (searched.mode === 'regex') return null;
  // found the way the search found it: with the case of the letters, or without
  const op = searched.caseSensitive ? 'contains' : 'containsNoCase';
  return {
    // `number`: the column is compared as text, whatever it is
    conditions: [{ column, op, values: [searched.text], kind: 'number', typeName: '' }],
    any: false,
    whereSql: '',
    order: [],
    limit: 1000,
  };
}

/** The object whose details show a definition; for a part of a table (`table.part`) the table. */
export function detailOf(hit: SourceHit): { name: string; kind: ObjectKind } | null {
  const table = hit.name.split('.')[0];
  switch (hit.kind) {
    case 'view':
      return { name: hit.name, kind: 'view' };
    case 'matview':
      return { name: hit.name, kind: 'matview' };
    case 'routine':
      return { name: hit.name, kind: 'routine' };
    case 'trigger':
    case 'check':
    case 'default':
      return hit.name.includes('.') ? { name: table, kind: 'table' } : null;
    case 'comment':
    case 'table':
      return { name: hit.name, kind: 'table' };
    default:
      return null;
  }
}

const cell = (text: string) => text.replace(/[\t\r\n]+/g, ' ');

/** The hits as tab-separated text: kind, schema, object, column or line, preview. */
export function hitsAsTsv(r: SearchResults): string {
  const lines = ['kind\tschema\tobject\tplace\ttext'];
  for (const t of r.tables) {
    for (const h of t.hits) {
      lines.push(['row', t.schema, t.table, h.column, h.preview].map(cell).join('\t'));
    }
  }
  for (const s of r.sources) {
    lines.push(
      [s.kind, s.schema, s.name, s.line > 0 ? String(s.line) : '', s.preview].map(cell).join('\t'),
    );
  }
  return `${lines.join('\n')}\n`;
}
