import { Dialect } from '../editor/sql-split';
import { SqlContext, TableRef } from './sql-context';
import { STATEMENTS, VALUE_WORDS, builtinsOf, keywordsAfter, typesOf } from './sql-words';

/**
 * What the completion offers for a context (prompt 021): pure – the names of the database come in as a
 * snapshot (`Meta`), the list goes out in the order it is shown. The service around it loads what the
 * snapshot needs and asks again.
 */
export interface ColumnMeta {
  readonly name: string;
  /** As it is written in SQL. */
  readonly quoted: string;
  readonly type: string;
  /** `pk`, `fk` or `''`. */
  readonly key?: string;
}

/** A foreign key between two tables, seen from the one that holds it. */
export interface ForeignKey {
  readonly columns: readonly string[];
  readonly refSchema: string;
  readonly refName: string;
  readonly refColumns: readonly string[];
}

export interface TableMeta {
  readonly schema: string;
  readonly name: string;
  readonly kind: 'table' | 'view' | 'matview';
  /** With its schema, as it is written in SQL. */
  readonly quoted: string;
  /** Without its schema. */
  readonly quotedName: string;
  /** `undefined` = not read yet. */
  readonly columns?: readonly ColumnMeta[];
  /** The tables it refers to … */
  readonly references?: readonly ForeignKey[];
  /** … and the foreign keys of other tables that refer to it (`schema`/`name` = the other table). */
  readonly referencedBy?: readonly (ForeignKey & {
    readonly schema: string;
    readonly name: string;
  })[];
}

export interface RoutineMeta {
  readonly schema: string;
  readonly name: string;
  /** Its arguments. */
  readonly detail: string;
  readonly quoted: string;
  readonly quotedName: string;
}

export interface Meta {
  readonly currentSchema: string;
  readonly schemas: readonly { readonly name: string; readonly quoted: string }[];
  readonly tables: readonly TableMeta[];
  readonly routines: readonly RoutineMeta[];
}

export const NO_META: Meta = { currentSchema: '', schemas: [], tables: [], routines: [] };

export interface SuggestOptions {
  readonly dialect: Dialect;
  /** Keywords as `SELECT` or as `select`. */
  readonly keywordCase: 'upper' | 'lower';
}

export type SuggestionKind =
  'table' | 'view' | 'column' | 'keyword' | 'function' | 'schema' | 'alias' | 'join' | 'type';

export interface Suggestion {
  readonly label: string;
  readonly insertText: string;
  readonly kind: SuggestionKind;
  /** At the right: a type, a schema, a table. */
  readonly detail: string;
  /** Below the list while the entry is active. */
  readonly documentation?: string;
  /** What typing filters on when that is not the label. */
  readonly filterText?: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The table of the snapshot a reference of the statement means; the current schema first. */
export function resolve(ref: TableRef, meta: Meta): TableMeta | undefined {
  const named = meta.tables.filter((t) => same(t.name, ref.name));
  if (ref.schema) return named.find((t) => same(t.schema, ref.schema!));
  return named.find((t) => same(t.schema, meta.currentSchema)) ?? named[0];
}

/** The columns of a reference: of a CTE or derived table as it names them, else of its table. */
function columnsOf(ref: TableRef, meta: Meta): ColumnMeta[] {
  if (ref.columns) return ref.columns.map((name) => ({ name, quoted: name, type: '' }));
  return [...(resolve(ref, meta)?.columns ?? [])];
}

/** An alias for a table: the first letters of its words, unlike the ones in use. */
export function aliasFor(name: string, taken: readonly string[]): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const base = (words.map((w) => w[0]).join('') || name.slice(0, 1) || 't').toLowerCase();
  let alias = base;
  for (let n = 2; taken.some((t) => same(t, alias)); n++) alias = `${base}${n}`;
  return alias;
}

/**
 * The tables a JOIN can go on with, each with its condition from a foreign key – in both directions, for
 * every table in reach.
 */
function joins(context: SqlContext, meta: Meta): Suggestion[] {
  const out: Suggestion[] = [];
  const taken = context.tables.map((t) => t.alias);
  const add = (
    target: { schema: string; name: string },
    left: readonly string[],
    right: readonly string[],
    from: TableRef,
  ) => {
    const table = meta.tables.find(
      (t) => same(t.name, target.name) && same(t.schema, target.schema),
    );
    // a table that is joined already is not offered again (a self join is written by hand)
    const joined = context.tables.some((t) => {
      const known = t.local ? undefined : resolve(t, meta);
      return known ? same(known.name, target.name) && same(known.schema, target.schema) : false;
    });
    if (joined) return;
    const written = table
      ? same(table.schema, meta.currentSchema)
        ? table.quotedName
        : table.quoted
      : target.name;
    const alias = aliasFor(target.name, taken);
    const on = left.map((l, i) => `${alias}.${l} = ${from.alias}.${right[i] ?? l}`).join(' AND ');
    const text = `${written} ${alias} ON ${on}`;
    if (!out.some((o) => o.insertText === text)) {
      out.push({
        label: text,
        insertText: text,
        kind: 'join',
        detail: '',
        filterText: target.name,
      });
    }
  };
  for (const ref of context.tables) {
    const table = ref.local ? undefined : resolve(ref, meta);
    if (!table) continue;
    for (const fk of table.references ?? []) {
      add({ schema: fk.refSchema, name: fk.refName }, fk.refColumns, fk.columns, ref);
    }
    for (const fk of table.referencedBy ?? []) {
      add({ schema: fk.schema, name: fk.name }, fk.columns, fk.refColumns, ref);
    }
  }
  return out;
}

function tables(context: SqlContext, meta: Meta, schema: string | null): Suggestion[] {
  const out: Suggestion[] = [];
  if (schema === null) {
    for (const cte of context.ctes) {
      out.push({ label: cte.name, insertText: cte.name, kind: 'alias', detail: 'CTE' });
    }
  }
  const wanted = meta.tables.filter((t) => schema === null || same(t.schema, schema));
  const here = (t: TableMeta) => same(t.schema, meta.currentSchema);
  // the current schema first; in a list for one schema, and in the current one, the name alone is enough
  for (const t of [...wanted.filter(here), ...wanted.filter((t) => !here(t))]) {
    const plain = schema !== null || here(t);
    out.push({
      label: plain ? t.name : `${t.schema}.${t.name}`,
      insertText: plain ? t.quotedName : t.quoted,
      kind: t.kind === 'table' ? 'table' : 'view',
      detail: t.schema,
      filterText: t.name,
    });
  }
  if (schema === null) {
    for (const s of meta.schemas) {
      out.push({ label: s.name, insertText: s.quoted, kind: 'schema', detail: '' });
    }
  }
  return out;
}

function columns(context: SqlContext, meta: Meta, options: SuggestOptions): Suggestion[] {
  const out: Suggestion[] = [];
  const all = context.tables.map((ref) => ({ ref, columns: columnsOf(ref, meta) }));
  const count = new Map<string, number>();
  for (const t of all) {
    for (const c of t.columns)
      count.set(c.name.toLowerCase(), (count.get(c.name.toLowerCase()) ?? 0) + 1);
  }
  // what the select list names: GROUP BY and ORDER BY usually repeat it
  if (context.clause === 'GROUP BY' || context.clause === 'ORDER BY') {
    for (const name of context.selected) {
      out.push({ label: name, insertText: name, kind: 'column', detail: 'SELECT' });
    }
  }
  for (const t of all) {
    for (const c of t.columns) {
      if (out.some((o) => o.label === c.name && o.detail === 'SELECT')) continue;
      // a name two tables have is written with its table
      const ambiguous = (count.get(c.name.toLowerCase()) ?? 0) > 1;
      const text = ambiguous ? `${t.ref.alias}.${c.quoted}` : c.quoted;
      out.push({
        label: ambiguous ? `${t.ref.alias}.${c.name}` : c.name,
        insertText: text,
        kind: 'column',
        detail: [c.type, all.length > 1 && !ambiguous ? t.ref.alias : '']
          .filter(Boolean)
          .join(' · '),
        filterText: c.name,
      });
    }
  }
  for (const t of context.tables) {
    out.push({
      label: t.alias,
      insertText: t.alias,
      kind: 'alias',
      detail: t.alias === t.name ? '' : t.name,
    });
  }
  for (const r of meta.routines) {
    out.push({
      label: r.name,
      insertText: same(r.schema, meta.currentSchema) ? r.quotedName : r.quoted,
      kind: 'function',
      detail: r.schema,
      documentation: `${r.name}(${r.detail})`,
    });
  }
  for (const b of builtinsOf(options.dialect)) {
    out.push({
      label: b.name,
      insertText: b.name,
      kind: 'function',
      detail: '',
      documentation: b.signature,
    });
  }
  out.push(...keywords(VALUE_WORDS, options));
  return out;
}

function keywords(words: readonly string[], options: SuggestOptions): Suggestion[] {
  return words.map((w) => {
    const text = options.keywordCase === 'lower' ? w.toLowerCase() : w;
    return { label: text, insertText: text, kind: 'keyword' as const, detail: '' };
  });
}

/** The list for a context, in the order it is shown. */
export function suggest(context: SqlContext, meta: Meta, options: SuggestOptions): Suggestion[] {
  switch (context.expect) {
    case 'none':
      return [];
    case 'statement':
      return keywords(STATEMENTS, options);
    case 'keyword':
      return keywords(keywordsAfter(context.clause, options.dialect), options);
    case 'type':
      return typesOf(options.dialect).map((t) => ({
        label: t,
        insertText: t,
        kind: 'type' as const,
        detail: '',
      }));
    case 'routine':
      return meta.routines.map((r) => ({
        label: r.name,
        insertText: same(r.schema, meta.currentSchema) ? r.quotedName : r.quoted,
        kind: 'function' as const,
        detail: r.schema,
        documentation: `${r.name}(${r.detail})`,
      }));
    case 'table':
      return tables(context, meta, context.qualifier[context.qualifier.length - 1] ?? null);
    case 'join':
      return [...joins(context, meta), ...tables(context, meta, null)];
    case 'insertColumns': {
      const target = context.tables[0];
      const list = target ? columnsOf(target, meta) : [];
      const single = list.map((c) => ({
        label: c.name,
        insertText: c.quoted,
        kind: 'column' as const,
        detail: c.type,
      }));
      if (list.length < 2) return single;
      const every = list.map((c) => c.quoted).join(', ');
      // the whole list in one go – what one wants most often here
      return [
        { label: every, insertText: every, kind: 'column', detail: '', filterText: list[0].name },
        ...single,
      ];
    }
    case 'column': {
      const q = context.qualifier;
      if (q.length === 0) return columns(context, meta, options);
      const last = q[q.length - 1];
      const ref = context.tables.find(
        (t) =>
          same(t.alias, last) && (q.length < 2 || !t.schema || same(t.schema, q[q.length - 2])),
      );
      if (ref) {
        return columnsOf(ref, meta).map((c) => ({
          label: c.name,
          insertText: c.quoted,
          kind: 'column' as const,
          detail: c.type,
        }));
      }
      // not a table of the statement: a schema, or a table that is named in full
      if (q.length === 1 && meta.schemas.some((s) => same(s.name, last)))
        return tables(context, meta, last);
      const table = meta.tables.find(
        (t) => same(t.name, last) && (q.length < 2 || same(t.schema, q[q.length - 2])),
      );
      return (table?.columns ?? []).map((c) => ({
        label: c.name,
        insertText: c.quoted,
        kind: 'column' as const,
        detail: c.type,
      }));
    }
  }
}

/** What a context needs of the database before `suggest` can answer in full. */
export interface Needs {
  /** Tables whose columns are asked for. */
  readonly columnsOf: readonly TableRef[];
  /** The foreign keys of the tables in reach are asked for. */
  readonly joins: boolean;
  /** Tables are listed: of this schema, or of all (`null`). `undefined` = none. */
  readonly tablesIn?: string | null;
  readonly routines: boolean;
}

export function needsOf(context: SqlContext): Needs {
  const real = context.tables.filter((t) => !t.local);
  const q = context.qualifier;
  switch (context.expect) {
    case 'table':
      return { columnsOf: [], joins: false, tablesIn: q[q.length - 1] ?? null, routines: false };
    case 'join':
      return { columnsOf: [], joins: true, tablesIn: null, routines: false };
    case 'routine':
      return { columnsOf: [], joins: false, routines: true };
    case 'insertColumns':
      return { columnsOf: real.slice(0, 1), joins: false, routines: false };
    case 'column': {
      if (q.length === 0) return { columnsOf: real, joins: false, routines: true };
      const last = q[q.length - 1];
      const ref = context.tables.find((t) => same(t.alias, last));
      if (ref) return { columnsOf: ref.local ? [] : [ref], joins: false, routines: false };
      // a schema (its tables) or a table named in full (its columns)
      return {
        columnsOf: [{ schema: q.length > 1 ? q[q.length - 2] : null, name: last, alias: last }],
        joins: false,
        tablesIn: q.length === 1 ? last : undefined,
        routines: false,
      };
    }
    default:
      return { columnsOf: [], joins: false, routines: false };
  }
}
