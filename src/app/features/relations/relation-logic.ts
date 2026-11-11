import { ForeignKey, TableRelations } from '../../core/schema/schema.models';
import { Cell, ColKind, KeySet, QueryColumn, RowWindow } from '../../core/sql/query.models';
import { DEFAULT_LIMIT, EMPTY_SPEC, TableView } from '../filter/filter-logic';

/**
 * Pure logic of following foreign keys (prompt 030): which key a cell belongs to, which values of the
 * marked rows make up the key, which table view shows the relatives – and the path the user came along.
 * No SQL is written here: a view names a table and key values, the backend builds the statement and
 * binds every value (`db/filter.rs`).
 */

/** Rows of a key at most (`MAX_KEY_ROWS` in filter.rs). */
export const MAX_KEY_ROWS = 1000;
/** Values of all key rows together at most (`MAX_KEY_VALUES`). */
export const MAX_KEY_VALUES = 2000;
/**
 * Characters of a text that can be a key. The rows of a result carry long texts cut (at 1000 characters):
 * a text that long may not be the whole value, so it is no key to follow.
 */
export const MAX_KEY_CHARS = 999;
/** Relations a user may define per connection. */
export const MAX_VIRTUAL = 500;

/** Which way a key is followed: to what the row points to, or to the rows that point to it. */
export type Direction = 'forward' | 'backward';

const same = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();

/** The index of a column of the result by its name: exactly, else without case; `-1` if it is not there. */
export function columnIndex(columns: readonly QueryColumn[], name: string): number {
  const exact = columns.findIndex((c) => c.name === name);
  return exact >= 0 ? exact : columns.findIndex((c) => same(c.name, name));
}

/** The keys of the table and the user's own for it, the catalog's first; each pair of ends once. */
export function withVirtual(
  relations: TableRelations,
  virtual: readonly ForeignKey[],
  schema: string,
  table: string,
): TableRelations {
  const id = (k: ForeignKey) =>
    [k.schema, k.table, k.columns.join(','), k.refSchema, k.refTable, k.refColumns.join(',')]
      .join('|')
      .toLowerCase();
  const merge = (real: readonly ForeignKey[], own: ForeignKey[]) => {
    const seen = new Set(real.map(id));
    return [...real, ...own.filter((k) => !seen.has(id(k)) && !!seen.add(id(k)))];
  };
  return {
    outgoing: merge(
      relations.outgoing,
      virtual.filter((k) => same(k.schema, schema) && same(k.table, table)),
    ),
    incoming: merge(
      relations.incoming,
      virtual.filter((k) => same(k.refSchema, schema) && same(k.refTable, table)),
    ),
  };
}

/** The keys a column is part of, those of one column first. */
export function keysOfColumn(relations: TableRelations, column: string): ForeignKey[] {
  return relations.outgoing
    .filter((k) => k.columns.some((c) => same(c, column)))
    .sort((a, b) => a.columns.length - b.columns.length);
}

/** The columns of a result that are part of a key the table has: their cells are links. */
export function linkColumns(
  relations: TableRelations | undefined,
  columns: readonly QueryColumn[],
): ReadonlySet<number> {
  const out = new Set<number>();
  for (const key of relations?.outgoing ?? []) {
    const at = key.columns.map((c) => columnIndex(columns, c));
    // a key whose columns are not all in the result cannot be followed
    if (at.every((i) => i >= 0)) at.forEach((i) => out.add(i));
  }
  return out;
}

const kindOf = (kind: ColKind): 'number' | 'bool' | 'text' =>
  kind === 'int' || kind === 'float' || kind === 'decimal'
    ? 'number'
    : kind === 'bool'
      ? 'bool'
      : 'text';

/** The text of a cell as a key value; `null` for NULL and for what is no value to compare. */
function keyText(cell: Cell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'object') return null;
  return String(cell);
}

/** What the marked rows give as a key. */
export interface KeyValues {
  /** `null`: a column of the key is not in the result. */
  readonly keys: KeySet | null;
  /** Rows left out because a part of their key is NULL (NULL references nothing). */
  readonly nulls: number;
  /** More different keys than a statement takes: only the first are in `keys`. */
  readonly cut: boolean;
  /** Rows left out because a part of their key is a text too long to be sure it is whole. */
  readonly long: number;
}

/**
 * The key values of some rows of a result. `from`: the columns of the result that hold the values, `to`:
 * the columns of the table they are looked up in (pair by pair). Each different key once; the types of
 * the values are those of the result's columns.
 */
export function keyValues(
  rows: RowWindow,
  columns: readonly QueryColumn[],
  from: readonly string[],
  to: readonly string[],
): KeyValues {
  const at = from.map((name) => columnIndex(columns, name));
  if (at.length === 0 || at.length !== to.length || at.some((i) => i < 0)) {
    return { keys: null, nulls: 0, cut: false, long: 0 };
  }
  const max = Math.min(MAX_KEY_ROWS, Math.floor(MAX_KEY_VALUES / at.length));
  const seen = new Set<string>();
  const out: string[][] = [];
  let nulls = 0;
  let long = 0;
  let cut = false;
  for (const row of rows) {
    const values = at.map((i) => keyText(row[i]));
    if (values.some((v) => v === null)) {
      nulls++;
      continue;
    }
    if (values.some((v) => [...(v as string)].length > MAX_KEY_CHARS)) {
      long++;
      continue;
    }
    const id = JSON.stringify(values);
    if (seen.has(id)) continue;
    seen.add(id);
    if (out.length >= max) {
      cut = true;
      continue;
    }
    out.push(values as string[]);
  }
  return {
    keys: {
      columns: to.map((column, n) => ({
        column,
        kind: kindOf(columns[at[n]].kind),
        typeName: columns[at[n]].typeName,
      })),
      rows: out,
    },
    nulls,
    cut,
    long,
  };
}

/** The ends of a key seen from one side: where the values are, and where they are looked up. */
export function ends(key: ForeignKey, direction: Direction) {
  return direction === 'forward'
    ? { from: key.columns, to: key.refColumns, schema: key.refSchema, table: key.refTable }
    : { from: key.refColumns, to: key.columns, schema: key.schema, table: key.table };
}

/** The table view that shows the relatives of some rows; `null` if no row has a key. */
export function relatedView(
  key: ForeignKey,
  direction: Direction,
  rows: RowWindow,
  columns: readonly QueryColumn[],
): { readonly view: TableView | null; readonly values: KeyValues } {
  const e = ends(key, direction);
  const values = keyValues(rows, columns, e.from, e.to);
  if (!values.keys || values.keys.rows.length === 0) return { view: null, values };
  return {
    view: {
      schema: e.schema === '' ? null : e.schema,
      table: e.table,
      spec: { ...EMPTY_SPEC, limit: DEFAULT_LIMIT, keys: values.keys },
    },
    values,
  };
}

/** `orders (customer_id)`, with the schema when it is another one. */
export function keyLabel(key: ForeignKey, direction: Direction, schema: string | null): string {
  const e = ends(key, direction);
  const table =
    e.schema !== '' && !same(e.schema, schema ?? '') ? `${e.schema}.${e.table}` : e.table;
  return `${table} (${e.to.join(', ')})`;
}

/** A short text for a key filter: `customer_id = 42`, `customer_id: 3 values` is the caller's. */
export function singleKeyText(keys: KeySet): string | null {
  if (keys.rows.length !== 1) return null;
  return keys.columns.map((c, i) => `${c.column} = ${keys.rows[0][i]}`).join(', ');
}

// --- the path -------------------------------------------------------------------------------------

/** A place the user was at: a table view, and what the path calls it. */
export interface NavEntry {
  readonly view: TableView;
  readonly title: string;
}

/** Where the user came along in a tab, and where on it they are – as in a browser. */
export interface NavState {
  readonly entries: readonly NavEntry[];
  readonly index: number;
}

export const EMPTY_NAV: NavState = { entries: [], index: -1 };
/** Places kept. */
export const MAX_NAV = 50;

/** Goes on to a new place: what lay ahead is gone. */
export function navPush(nav: NavState, entry: NavEntry): NavState {
  const entries = [...nav.entries.slice(0, nav.index + 1), entry].slice(-MAX_NAV);
  return { entries, index: entries.length - 1 };
}

/** The place the user is at shows another filter now: the path remembers it. */
export function navReplace(nav: NavState, view: TableView): NavState {
  const at = nav.entries[nav.index];
  if (!at) return nav;
  // another table in the same tab is another walk
  if (at.view.table !== view.table || at.view.schema !== view.schema) return EMPTY_NAV;
  const entries = [...nav.entries];
  entries[nav.index] = { ...at, view };
  return { entries, index: nav.index };
}

export function navGo(nav: NavState, index: number): NavState {
  return index >= 0 && index < nav.entries.length ? { ...nav, index } : nav;
}

export const canBack = (nav: NavState) => nav.index > 0;
export const canForward = (nav: NavState) => nav.index < nav.entries.length - 1;

// --- relations of the user's own ---------------------------------------------------------------------

/** A relation as it is stored; whatever is none is left out. */
export function readVirtual(raw: unknown): ForeignKey[] {
  if (!Array.isArray(raw)) return [];
  const text = (v: unknown) => (typeof v === 'string' && v.length <= 256 ? v : null);
  const names = (v: unknown) =>
    Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every((n) => !!text(n))
      ? (v as string[])
      : null;
  const out: ForeignKey[] = [];
  for (const item of raw.slice(0, MAX_VIRTUAL)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const table = text(r['table']);
    const refTable = text(r['refTable']);
    const columns = names(r['columns']);
    const refColumns = names(r['refColumns']);
    if (!table || !refTable || !columns || !refColumns || columns.length !== refColumns.length)
      continue;
    out.push({
      name: '',
      schema: text(r['schema']) ?? '',
      table,
      columns,
      refSchema: text(r['refSchema']) ?? '',
      refTable,
      refColumns,
    });
  }
  return out;
}

/**
 * Where a column may point to, guessed from its name – an offer, nothing more: `customer_id` →
 * `customer.id` and `customers.id`, `countryCode` → `country.code`.
 */
export function suggestTargets(column: string): { table: string; column: string }[] {
  const m = /^(.+?)(?:_|(?=[A-Z]))(id|key|code|no|nr|uuid)$/i.exec(column);
  if (!m) return [];
  const base = m[1].replace(/_+$/, '');
  const target = m[2].toLowerCase();
  if (base === '') return [];
  const plural = /s$/i.test(base)
    ? `${base}es`
    : /y$/i.test(base)
      ? `${base.slice(0, -1)}ies`
      : `${base}s`;
  return [
    { table: base, column: target },
    { table: plural, column: target },
  ];
}
