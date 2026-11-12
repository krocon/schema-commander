import { DbKind } from '../../core/connections/connection.models';
import {
  ColumnInfo,
  Found,
  ObjectInfo,
  ObjectKind,
  SchemaInfo,
  TableInfo,
} from '../../core/schema/schema.models';
import { locale } from '../../core/i18n/i18n';
import { SCHEMA_TEXTS } from './schema-texts';

/** Something that is asked of the backend. */
export type Loadable<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'error'; readonly message: string };

/** What is known of one connection. */
export interface SchemaState {
  readonly schemas: Loadable<readonly SchemaInfo[]> | null;
  /** By schema name. */
  readonly objects: Readonly<Record<string, Loadable<readonly ObjectInfo[]>>>;
  /** By `tableKey`. */
  readonly tables: Readonly<Record<string, Loadable<TableInfo>>>;
  /** Ids of the open nodes. */
  readonly expanded: ReadonlySet<string>;
  /** Hits of the name search on the server for `foundFor`. */
  readonly found: readonly Found[];
  readonly foundFor: string;
}

export const EMPTY_STATE: SchemaState = {
  schemas: null,
  objects: {},
  tables: {},
  expanded: new Set(),
  found: [],
  foundFor: '',
};

export type RowKind = 'schema' | 'group' | 'object' | 'column' | 'section' | 'part' | 'info';

/** A visible row of the tree. */
export interface TreeRow {
  readonly id: string;
  /** 1 = a schema. */
  readonly level: number;
  readonly kind: RowKind;
  readonly label: string;
  /** Shown dimmed behind the label: a type, a count, a definition. */
  readonly detail: string;
  /** A letter or sign in front of the label. */
  readonly icon: string;
  /** A class for the icon (`ge-*` are not ours: `st-table`, `st-view` …). */
  readonly tone: string;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly schema: SchemaInfo | null;
  readonly object: ObjectInfo | null;
  readonly column: ColumnInfo | null;
  /** An `info` row that reports a failure. */
  readonly error: boolean;
}

const SEP = '\u0001';

export const schemaId = (schema: string) => `s${SEP}${schema}`;
export const groupId = (schema: string, kind: ObjectKind) => `g${SEP}${schema}${SEP}${kind}`;
export const objectId = (schema: string, o: Pick<ObjectInfo, 'kind' | 'name' | 'detail'>) =>
  `o${SEP}${schema}${SEP}${o.kind}${SEP}${o.name}${SEP}${o.kind === 'routine' ? o.detail : ''}`;
export const tableKey = (schema: string, table: string) => `${schema}${SEP}${table}`;

/** The sorts of objects in the order of the tree; their names are `SCHEMA_TEXTS.groups`. */
export const GROUPS: readonly { kind: ObjectKind; icon: string }[] = [
  { kind: 'table', icon: 'T' },
  { kind: 'view', icon: 'V' },
  { kind: 'matview', icon: 'M' },
  { kind: 'routine', icon: 'ƒ' },
  { kind: 'sequence', icon: 'S' },
  { kind: 'type', icon: 'Y' },
];

/** Tables, views and materialized views have columns. */
export const hasColumns = (kind: ObjectKind) =>
  kind === 'table' || kind === 'view' || kind === 'matview';

/** A row count as the tree shows it: an estimate, so rounded for the eye. */
export function rowEstimate(rows: number | null): string {
  if (rows === null) return '';
  if (rows < 1000) return `~${rows}`;
  const short = (n: number) =>
    new Intl.NumberFormat(locale(), { maximumFractionDigits: 1, useGrouping: false }).format(n);
  if (rows < 1_000_000) return SCHEMA_TEXTS.thousands(short(Math.round(rows / 100) / 10));
  return SCHEMA_TEXTS.millions(short(Math.round(rows / 100_000) / 10));
}

/**
 * Whether `text` holds `query`: as it is anywhere, or its characters in this order. Both lower case.
 */
export function matches(query: string, text: string): boolean {
  if (query === '') return true;
  if (text.includes(query)) return true;
  let from = 0;
  for (const ch of query) {
    const at = text.indexOf(ch, from);
    if (at < 0) return false;
    from = at + ch.length;
  }
  return true;
}

function row(over: Partial<TreeRow> & Pick<TreeRow, 'id' | 'level' | 'kind' | 'label'>): TreeRow {
  return {
    detail: '',
    icon: '',
    tone: '',
    expandable: false,
    expanded: false,
    schema: null,
    object: null,
    column: null,
    error: false,
    ...over,
  };
}

function info(id: string, level: number, label: string, error = false): TreeRow {
  return row({ id: `i${SEP}${id}`, level, kind: 'info', label, error });
}

function tableRows(out: TreeRow[], id: string, level: number, table: Loadable<TableInfo>): void {
  if (table.state === 'loading') {
    out.push(info(id, level, SCHEMA_TEXTS.loading));
    return;
  }
  if (table.state === 'error') {
    out.push(info(id, level, table.message, true));
    return;
  }
  const t = table.value;
  for (const c of t.columns) {
    out.push(
      row({
        id: `c${SEP}${id}${SEP}${c.name}`,
        level,
        kind: 'column',
        label: c.name,
        detail: `${c.typeName}${c.nullable ? '' : ' not null'}`,
        icon: c.key === 'pk' ? '🔑' : c.key === 'fk' ? '↗' : '·',
        tone: c.key ? `st-${c.key}` : 'st-column',
        column: c,
      }),
    );
  }
  const sections: [string, string, readonly { name: string; detail: string }[]][] = [
    [SCHEMA_TEXTS.indexes, 'x', t.indexes],
    [SCHEMA_TEXTS.keys, 'k', t.keys],
    [SCHEMA_TEXTS.triggers, 't', t.triggers],
  ];
  for (const [label, key, list] of sections) {
    if (list.length === 0) continue;
    out.push(
      row({
        id: `h${SEP}${id}${SEP}${key}`,
        level,
        kind: 'section',
        label,
        detail: String(list.length),
      }),
    );
    for (const p of list) {
      out.push(
        row({
          id: `p${SEP}${id}${SEP}${key}${SEP}${p.name}`,
          level: level + 1,
          kind: 'part',
          label: p.name,
          detail: p.detail,
        }),
      );
    }
  }
}

/**
 * The visible rows of the tree. With a `filter` only the objects whose name matches are shown, with their
 * schema and sort open, whatever is expanded; hits of the server (`found`) stand in for schemas that were
 * never opened.
 */
export function flatten(state: SchemaState, showSystem: boolean, filter = ''): TreeRow[] {
  const out: TreeRow[] = [];
  const schemas = state.schemas;
  if (schemas === null) return out;
  if (schemas.state === 'loading') return [info('root', 1, SCHEMA_TEXTS.loading)];
  if (schemas.state === 'error') return [info('root', 1, schemas.message, true)];
  const query = filter.trim().toLowerCase();
  const filtering = query !== '';
  for (const schema of schemas.value) {
    if (schema.system && !showSystem) continue;
    const sid = schemaId(schema.name);
    const loaded = state.objects[schema.name];
    let list: readonly ObjectInfo[] | null = loaded?.state === 'ready' ? loaded.value : null;
    if (filtering) {
      if (list !== null) {
        list = list.filter((o) => matches(query, o.name.toLowerCase()));
      } else if (state.foundFor === query) {
        list = state.found
          .filter((f) => f.schema === schema.name)
          .map((f) => ({ kind: f.kind, name: f.name, quoted: f.quoted, detail: '', rows: null }));
      }
      // a schema without a hit is left out
      if (list === null || list.length === 0) continue;
    }
    const open = filtering || state.expanded.has(sid);
    out.push(
      row({
        id: sid,
        level: 1,
        kind: 'schema',
        label: schema.name,
        detail: schema.current ? SCHEMA_TEXTS.current : '',
        icon: '▣',
        tone: schema.system ? 'st-system' : 'st-schema',
        expandable: true,
        expanded: open,
        schema,
      }),
    );
    if (!open) continue;
    if (list === null) {
      if (loaded?.state === 'error') out.push(info(sid, 2, loaded.message, true));
      else out.push(info(sid, 2, SCHEMA_TEXTS.loading));
      continue;
    }
    if (list.length === 0) {
      out.push(info(sid, 2, SCHEMA_TEXTS.empty));
      continue;
    }
    for (const group of GROUPS) {
      const members = list.filter((o) => o.kind === group.kind);
      if (members.length === 0) continue;
      const gid = groupId(schema.name, group.kind);
      const groupOpen = filtering || state.expanded.has(gid);
      out.push(
        row({
          id: gid,
          level: 2,
          kind: 'group',
          label: SCHEMA_TEXTS.groups[group.kind],
          detail: String(members.length),
          expandable: true,
          expanded: groupOpen,
          schema,
        }),
      );
      if (!groupOpen) continue;
      for (const o of members) {
        const oid = objectId(schema.name, o);
        const expandable = hasColumns(o.kind);
        const objectOpen = expandable && state.expanded.has(oid);
        out.push(
          row({
            id: oid,
            level: 3,
            kind: 'object',
            label: o.name,
            detail: o.kind === 'table' ? rowEstimate(o.rows) || o.detail : o.detail,
            icon: group.icon,
            tone: `st-${o.kind}`,
            expandable,
            expanded: objectOpen,
            schema,
            object: o,
          }),
        );
        if (objectOpen) {
          tableRows(
            out,
            oid,
            4,
            state.tables[tableKey(schema.name, o.name)] ?? { state: 'loading' },
          );
        }
      }
    }
  }
  if (filtering && out.length === 0) out.push(info('none', 1, SCHEMA_TEXTS.nothingFound));
  return out;
}

/** The row to go to with a key of the tree (APG): the index of the next active row, or what to toggle. */
export type KeyMove =
  { readonly to: number } | { readonly toggle: string } | { readonly open: number } | null;

/** Arrow keys, Home, End, Enter on the row `at` of `rows` (APG tree pattern). */
export function keyMove(rows: readonly TreeRow[], at: number, key: string): KeyMove {
  if (rows.length === 0) return null;
  const current = rows[at];
  switch (key) {
    case 'ArrowDown':
      return { to: Math.min(rows.length - 1, at + 1) };
    case 'ArrowUp':
      return { to: Math.max(0, at - 1) };
    case 'Home':
      return { to: 0 };
    case 'End':
      return { to: rows.length - 1 };
    case 'PageDown':
      return { to: Math.min(rows.length - 1, at + 15) };
    case 'PageUp':
      return { to: Math.max(0, at - 15) };
    case 'ArrowRight':
      if (!current?.expandable) return null;
      // closed: open it; open: to its first child
      if (!current.expanded) return { toggle: current.id };
      return at + 1 < rows.length && rows[at + 1].level > current.level ? { to: at + 1 } : null;
    case 'ArrowLeft': {
      if (!current) return null;
      if (current.expandable && current.expanded) return { toggle: current.id };
      // to the parent
      for (let i = at - 1; i >= 0; i--) if (rows[i].level < current.level) return { to: i };
      return null;
    }
    case 'Enter':
      return current ? { open: at } : null;
    default:
      return null;
  }
}

// --- names and templates --------------------------------------------------------------------------------

/** The name of an object as it is written in SQL: without its schema where the schema is the current one. */
export function qualifiedName(
  schema: Pick<SchemaInfo, 'quoted' | 'current'>,
  object: Pick<ObjectInfo, 'quoted'>,
): string {
  return schema.current ? object.quoted : `${schema.quoted}.${object.quoted}`;
}

/** Rows a table is opened with. */
export const OPEN_ROWS = 200;

/** `SELECT` of the first rows of a table, in the dialect of the database. */
export function selectTemplate(
  kind: DbKind,
  name: string,
  columns: readonly Pick<ColumnInfo, 'quoted'>[] = [],
  limit = OPEN_ROWS,
): string {
  const list = columns.length > 0 ? columns.map((c) => c.quoted).join(', ') : '*';
  if (kind === 'oracle') return `SELECT ${list}\nFROM ${name}\nFETCH FIRST ${limit} ROWS ONLY;`;
  return kind === 'sqlserver'
    ? `SELECT TOP ${limit} ${list}\nFROM ${name};`
    : `SELECT ${list}\nFROM ${name}\nLIMIT ${limit};`;
}

/** A name inside a snippet of the editor: `$`, `}` and `\` are signs there. */
export function snippetText(text: string): string {
  return text.replace(/[\\$}]/g, '\\$&');
}

/** `INSERT` with a placeholder per column (a snippet of the editor). */
export function insertSnippet(name: string, columns: readonly ColumnInfo[]): string {
  const names = columns.map((c) => snippetText(c.quoted)).join(', ');
  const values = columns.map((c, i) => `\${${i + 1}:${snippetText(c.name)}}`).join(', ');
  return `INSERT INTO ${snippetText(name)} (${names})\nVALUES (${values});$0`;
}

/** `UPDATE` with a placeholder per column that is no primary key, and the key in the condition. */
export function updateSnippet(name: string, columns: readonly ColumnInfo[]): string {
  const keys = columns.filter((c) => c.key === 'pk');
  const rest = columns.filter((c) => c.key !== 'pk');
  let n = 0;
  const set = (rest.length > 0 ? rest : columns)
    .map((c) => `${snippetText(c.quoted)} = \${${++n}:${snippetText(c.name)}}`)
    .join(',\n    ');
  const where =
    keys.length > 0
      ? keys
          .map((c) => `${snippetText(c.quoted)} = \${${++n}:${snippetText(c.name)}}`)
          .join(' AND ')
      : `\${${++n}:${snippetText(SCHEMA_TEXTS.condition)}}`;
  return `UPDATE ${snippetText(name)}\nSET ${set}\nWHERE ${where};$0`;
}

/** Whether a statement changes what the tree shows (so it is read again afterwards). */
export function changesSchema(sql: string): boolean {
  const start = sql
    .replace(/^(\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '')
    .slice(0, 12)
    .toLowerCase();
  return /^(create|alter|drop|rename|truncate|comment|attach|detach|use)\b/.test(start);
}

/** Columns a quick info shows at most. */
export const QUICK_INFO_COLUMNS = 30;

/** The lines of a quick info: each column with its type and key, the rest counted. */
export function quickInfoLines(columns: readonly ColumnInfo[]): string[] {
  const lines = columns.slice(0, QUICK_INFO_COLUMNS).map((c) => {
    const marks = [c.key === 'pk' ? 'PK' : c.key === 'fk' ? 'FK' : '', c.nullable ? '' : 'NOT NULL']
      .filter(Boolean)
      .join(', ');
    return `${c.name}  ${c.typeName}${marks ? `  (${marks})` : ''}`;
  });
  if (columns.length > QUICK_INFO_COLUMNS) lines.push(`… +${columns.length - QUICK_INFO_COLUMNS}`);
  return lines;
}
