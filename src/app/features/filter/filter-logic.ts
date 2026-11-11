import {
  ColKind,
  FilterCondition,
  FilterOp,
  FilterOrder,
  QueryColumn,
  TableQuery,
  ViewSpec,
} from '../../core/sql/query.models';

/**
 * Pure logic of sorting and filtering (prompt 027): what a table view asks the server for, what a result
 * is looked at through locally, and how clicks and cells become conditions and sort keys. The statement
 * itself is built by the backend (`db/filter.rs`) – nothing here writes SQL.
 */

/** A table looked at as a table: the app writes its `SELECT`. */
export interface TableView {
  /** As the catalog has them (not quoted). `null`: looked up as the session does it. */
  readonly schema: string | null;
  readonly table: string;
  readonly spec: TableSpec;
}

/** The part of a table view the user changes. */
export interface TableSpec {
  readonly conditions: readonly FilterCondition[];
  readonly any: boolean;
  readonly whereSql: string;
  readonly order: readonly FilterOrder[];
  readonly limit: number | null;
}

/** Rows a table view reads unless told otherwise. */
export const DEFAULT_LIMIT = 1000;
export const LIMITS: readonly (number | null)[] = [200, 1000, 10_000, 100_000, null];

export const EMPTY_SPEC: TableSpec = {
  conditions: [],
  any: false,
  whereSql: '',
  order: [],
  limit: DEFAULT_LIMIT,
};

export function queryOf(view: TableView): TableQuery {
  const s = view.spec;
  return {
    schema: view.schema,
    table: view.table,
    conditions: s.conditions,
    any: s.any,
    whereSql: s.whereSql.trim() === '' ? null : s.whereSql.trim(),
    order: s.order,
    limit: s.limit,
  };
}

/** Something narrows or orders the view (the limit alone does not). */
export function isFiltered(spec: TableSpec): boolean {
  return spec.conditions.length > 0 || spec.whereSql.trim() !== '' || spec.order.length > 0;
}

/** The operators, in the order of the list; how many values each wants (`many`: a list). */
export const OPS: readonly { readonly op: FilterOp; readonly values: 0 | 1 | 2 | 'many' }[] = [
  { op: 'eq', values: 1 },
  { op: 'ne', values: 1 },
  { op: 'lt', values: 1 },
  { op: 'le', values: 1 },
  { op: 'gt', values: 1 },
  { op: 'ge', values: 1 },
  { op: 'contains', values: 1 },
  { op: 'like', values: 1 },
  { op: 'notLike', values: 1 },
  { op: 'in', values: 'many' },
  { op: 'between', values: 2 },
  { op: 'isNull', values: 0 },
  { op: 'isNotNull', values: 0 },
];

export const valuesOf = (op: FilterOp) => OPS.find((o) => o.op === op)?.values ?? 1;

/** What a value of a column is for the backend. */
export function valueKind(kind: ColKind): FilterCondition['kind'] {
  if (kind === 'int' || kind === 'float' || kind === 'decimal') return 'number';
  return kind === 'bool' ? 'bool' : 'text';
}

/** A row of the filter bar: a condition as it is typed (one text for all its values). */
export interface ConditionDraft {
  readonly column: string;
  readonly op: FilterOp;
  /** One value; for `in` a list separated by commas; for `between` the lower bound. */
  readonly text: string;
  /** The upper bound of `between`. */
  readonly upper: string;
}

/** The entries of a list as typed: separated by commas, or one per line. */
export function listValues(text: string): string[] {
  const parts = text.includes('\n') ? text.split('\n') : text.split(',');
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/**
 * A draft as a condition for the backend; `null` when it is not complete yet (no column, a value missing)
 * – such a row is left out, it is no error.
 */
export function conditionOf(
  draft: ConditionDraft,
  columns: readonly QueryColumn[],
): FilterCondition | null {
  const column = columns.find((c) => c.name === draft.column);
  if (!column) return null;
  const wants = valuesOf(draft.op);
  let values: string[];
  if (wants === 0) values = [];
  else if (wants === 2) values = [draft.text, draft.upper];
  else if (wants === 'many') values = listValues(draft.text);
  else values = [draft.text];
  if (wants === 2 && (draft.text === '' || draft.upper === '')) return null;
  if (wants === 'many' && values.length === 0) return null;
  // an empty text is a value for a text column (`= ''`, `<> ''`) – never a number or a pattern
  const comparesText =
    valueKind(column.kind) === 'text' && (draft.op === 'eq' || draft.op === 'ne');
  if (wants === 1 && draft.text === '' && !comparesText) return null;
  return {
    column: column.name,
    op: draft.op,
    values,
    kind: valueKind(column.kind),
    typeName: column.typeName,
  };
}

export function draftOf(condition: FilterCondition): ConditionDraft {
  const wants = valuesOf(condition.op);
  return {
    column: condition.column,
    op: condition.op,
    text: wants === 'many' ? condition.values.join(', ') : (condition.values[0] ?? ''),
    upper: wants === 2 ? (condition.values[1] ?? '') : '',
  };
}

/** What a quick filter from a cell asks for. */
export type QuickFilter = 'eq' | 'ne' | 'gt' | 'lt' | 'null';

/**
 * A condition from the cell under the cursor: only this value, without it, greater, smaller, is NULL.
 * A NULL cell has no value to compare with: „only this“ is `IS NULL`, „without“ `IS NOT NULL`, the rest
 * nothing.
 */
export function quickCondition(
  quick: QuickFilter,
  column: QueryColumn,
  value: string | null,
): FilterCondition | null {
  const base = { column: column.name, kind: valueKind(column.kind), typeName: column.typeName };
  if (quick === 'null') return { ...base, op: 'isNull', values: [] };
  if (value === null) {
    if (quick === 'eq') return { ...base, op: 'isNull', values: [] };
    if (quick === 'ne') return { ...base, op: 'isNotNull', values: [] };
    return null;
  }
  return { ...base, op: quick, values: [value] };
}

/** A spec with a condition added; the same condition twice is once. */
export function withCondition(spec: TableSpec, condition: FilterCondition): TableSpec {
  const same = (c: FilterCondition) =>
    c.column === condition.column &&
    c.op === condition.op &&
    c.values.join('\u0000') === condition.values.join('\u0000');
  return spec.conditions.some(same)
    ? spec
    : { ...spec, conditions: [...spec.conditions, condition] };
}

/**
 * What a click on a column head does to the order: up, down, off. A plain click orders by this column
 * alone; with the modifier the column joins the others (or changes its direction among them).
 */
export function toggleOrder<T extends { readonly desc: boolean }>(
  order: readonly T[],
  is: (key: T) => boolean,
  make: (desc: boolean) => T,
  additive: boolean,
): T[] {
  const at = order.findIndex(is);
  const now = at < 0 ? null : order[at];
  const next = now === null ? make(false) : now.desc ? null : make(true);
  if (!additive) return next ? [next] : [];
  if (at < 0) return next ? [...order, next] : [...order];
  return next ? order.map((k, i) => (i === at ? next : k)) : order.filter((_, i) => i !== at);
}

/** A click on a head of a table view. */
export function toggleServerOrder(
  order: readonly FilterOrder[],
  column: string,
  additive: boolean,
): FilterOrder[] {
  return toggleOrder(
    order,
    (o) => o.column === column,
    (desc) => ({ column, desc, nulls: null }),
    additive,
  );
}

/** A click on a head of any other result: sorted in the store. */
export function toggleLocalSort(
  sort: ViewSpec['sort'],
  column: number,
  additive: boolean,
): ViewSpec['sort'] {
  return toggleOrder(
    sort,
    (k) => k.column === column,
    (desc) => ({ column, desc }),
    additive,
  );
}

export const EMPTY_VIEW: ViewSpec = { text: '', column: null, sort: [] };

export const isLocal = (spec: ViewSpec) => spec.text.trim() !== '' || spec.sort.length > 0;

/** The mark of a column head: its direction and, among several keys, its rank. */
export interface SortMark {
  readonly column: number;
  readonly desc: boolean;
  /** From 1; 0 when it is the only key. */
  readonly rank: number;
}

export function sortMarks(
  columns: readonly QueryColumn[],
  server: readonly FilterOrder[] | null,
  local: ViewSpec['sort'],
): SortMark[] {
  const keys = server
    ? server
        .map((o) => ({ column: columns.findIndex((c) => c.name === o.column), desc: o.desc }))
        .filter((k) => k.column >= 0)
    : local;
  return keys.map((k, i) => ({ ...k, rank: keys.length > 1 ? i + 1 : 0 }));
}

/** What identifies a table for the filter that is remembered for it. */
export function tableKey(connectionId: string, view: Pick<TableView, 'schema' | 'table'>): string {
  return `${connectionId}|${view.schema ?? ''}.${view.table}`;
}

export const MAX_REMEMBERED = 200;

/** The remembered specs with one put in front (or taken out, when it filters nothing). */
export function remember(
  all: Readonly<Record<string, TableSpec>>,
  key: string,
  spec: TableSpec,
): Record<string, TableSpec> {
  const rest = Object.entries(all).filter(([k]) => k !== key);
  const kept = isFiltered(spec) ? [[key, spec] as [string, TableSpec], ...rest] : rest;
  return Object.fromEntries(kept.slice(0, MAX_REMEMBERED));
}

/** A stored spec, forgiving: what is none becomes the empty one. */
export function readSpec(raw: unknown): TableSpec {
  if (!raw || typeof raw !== 'object') return EMPTY_SPEC;
  const o = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
  const ops = new Set(OPS.map((x) => x.op as string));
  const conditions = (Array.isArray(o['conditions']) ? o['conditions'] : [])
    .map((c): FilterCondition | null => {
      if (!c || typeof c !== 'object') return null;
      const r = c as Record<string, unknown>;
      const column = text(r['column'], 256);
      const op = text(r['op'], 16);
      const values = Array.isArray(r['values'])
        ? r['values'].filter((v): v is string => typeof v === 'string' && v.length <= 2000)
        : [];
      const kind = r['kind'] === 'number' || r['kind'] === 'bool' ? r['kind'] : 'text';
      if (!column || !op || !ops.has(op)) return null;
      return {
        column,
        op: op as FilterOp,
        values: values.slice(0, 1000),
        kind,
        typeName: text(r['typeName'], 64) ?? '',
      };
    })
    .filter((c): c is FilterCondition => c !== null)
    .slice(0, 50);
  const order = (Array.isArray(o['order']) ? o['order'] : [])
    .map((x): FilterOrder | null => {
      if (!x || typeof x !== 'object') return null;
      const r = x as Record<string, unknown>;
      const column = text(r['column'], 256);
      if (!column) return null;
      const nulls = r['nulls'] === 'first' || r['nulls'] === 'last' ? r['nulls'] : null;
      return { column, desc: r['desc'] === true, nulls };
    })
    .filter((x): x is FilterOrder => x !== null)
    .slice(0, 50);
  const limit = o['limit'];
  return {
    conditions,
    any: o['any'] === true,
    whereSql: text(o['whereSql'], 10_000) ?? '',
    order,
    limit:
      limit === null
        ? null
        : typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= 10_000_000
          ? limit
          : DEFAULT_LIMIT,
  };
}
