/**
 * The structure of a table while it is edited (prompt 043): the form of the editor, what changed against
 * the table as it was read, and the request for the backend – which writes the DDL. Pure.
 */
import { DbKind } from '../../core/connections/connection.models';
import {
  CheckDef,
  ColumnDef,
  IndexDef,
  KeyDef,
  StructPlan,
  StructRequest,
  TableDef,
} from '../../core/structure/structure-api';

/** A column in the editor. `was`: its name when it was read; `null` = it is new. */
export interface EditedColumn {
  readonly id: number;
  readonly was: string | null;
  readonly name: string;
  readonly typeName: string;
  readonly nullable: boolean;
  /** `''` = no default. */
  readonly default: string;
  readonly pk: boolean;
}

/** An index in the editor: its columns as text (`a, b`). */
export interface EditedIndex {
  readonly id: number;
  /** The index as it was read (`null`: new). */
  readonly was: IndexDef | null;
  readonly name: string;
  readonly unique: boolean;
  readonly columns: string;
}

export interface EditedKey {
  readonly id: number;
  readonly was: KeyDef | null;
  readonly name: string;
  readonly columns: string;
  /** `table` or `schema.table`. */
  readonly refTable: string;
  readonly refColumns: string;
}

export interface EditedCheck {
  readonly id: number;
  readonly was: CheckDef | null;
  readonly name: string;
  readonly text: string;
}

export interface EditedTable {
  readonly name: string;
  readonly columns: readonly EditedColumn[];
  readonly indexes: readonly EditedIndex[];
  readonly keys: readonly EditedKey[];
  readonly checks: readonly EditedCheck[];
  /** The next id for a row of the editor. */
  readonly nextId: number;
}

/** `a, "b c"` → the names. A name in double quotes may hold a comma. */
export function splitNames(text: string): string[] {
  const out: string[] = [];
  let item = '';
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) {
      out.push(item);
      item = '';
    } else item += c;
  }
  out.push(item);
  return out.map((n) => n.trim()).filter((n) => n !== '');
}

/** The names as the editor shows them: those with a comma or a blank at their edge in quotes. */
export function joinNames(names: readonly string[]): string {
  return names.map((n) => (/[,"]|^\s|\s$/.test(n) ? `"${n}"` : n)).join(', ');
}

const refText = (key: KeyDef) =>
  key.refSchema ? `${key.refSchema}.${key.refTable}` : key.refTable;

/** The form of the editor for a table as it was read. */
export function fromTable(table: TableDef): EditedTable {
  let id = 1;
  return {
    name: table.name,
    columns: table.columns.map((c) => ({
      id: id++,
      was: c.name,
      name: c.name,
      typeName: c.typeName,
      nullable: c.nullable,
      default: c.default ?? '',
      pk: table.pk.includes(c.name),
    })),
    indexes: table.indexes.map((i) => ({
      id: id++,
      was: i,
      name: i.name,
      unique: i.unique,
      columns: joinNames(i.columns),
    })),
    keys: table.keys.map((k) => ({
      id: id++,
      was: k,
      name: k.name,
      columns: joinNames(k.columns),
      refTable: refText(k),
      refColumns: joinNames(k.refColumns),
    })),
    checks: table.checks.map((c) => ({ id: id++, was: c, name: c.name, text: c.text })),
    nextId: id,
  };
}

/** The types the editor proposes, by dialect. Any other text is taken as it is. */
export function typeSuggestions(kind: DbKind): readonly string[] {
  switch (kind) {
    case 'postgres':
      return [
        'integer',
        'bigint',
        'smallint',
        'numeric(12,2)',
        'real',
        'double precision',
        'boolean',
        'text',
        'varchar(255)',
        'char(1)',
        'date',
        'timestamp',
        'timestamptz',
        'time',
        'uuid',
        'jsonb',
        'bytea',
      ];
    case 'mysql':
      return [
        'int',
        'bigint',
        'smallint',
        'tinyint(1)',
        'decimal(12,2)',
        'double',
        'varchar(255)',
        'char(1)',
        'text',
        'longtext',
        'date',
        'datetime',
        'timestamp',
        'time',
        'json',
        'blob',
      ];
    case 'sqlserver':
      return [
        'int',
        'bigint',
        'smallint',
        'bit',
        'decimal(12,2)',
        'float',
        'nvarchar(255)',
        'nvarchar(max)',
        'varchar(255)',
        'char(1)',
        'date',
        'datetime2',
        'datetimeoffset',
        'time',
        'uniqueidentifier',
        'varbinary(max)',
      ];
    default:
      return ['INTEGER', 'REAL', 'NUMERIC', 'TEXT', 'BLOB'];
  }
}

/** A new table starts with a key column. */
export function emptyTable(kind: DbKind): EditedTable {
  const type = kind === 'sqlite' ? 'INTEGER' : kind === 'postgres' ? 'integer' : 'int';
  return {
    name: '',
    columns: [
      { id: 1, was: null, name: 'id', typeName: type, nullable: false, default: '', pk: true },
    ],
    indexes: [],
    keys: [],
    checks: [],
    nextId: 2,
  };
}

export function addColumn(t: EditedTable): EditedTable {
  const column: EditedColumn = {
    id: t.nextId,
    was: null,
    name: '',
    typeName: '',
    nullable: true,
    default: '',
    pk: false,
  };
  return { ...t, columns: [...t.columns, column], nextId: t.nextId + 1 };
}

export function addIndex(t: EditedTable): EditedTable {
  const index: EditedIndex = { id: t.nextId, was: null, name: '', unique: false, columns: '' };
  return { ...t, indexes: [...t.indexes, index], nextId: t.nextId + 1 };
}

export function addKey(t: EditedTable): EditedTable {
  const key: EditedKey = {
    id: t.nextId,
    was: null,
    name: '',
    columns: '',
    refTable: '',
    refColumns: '',
  };
  return { ...t, keys: [...t.keys, key], nextId: t.nextId + 1 };
}

export function addCheck(t: EditedTable): EditedTable {
  const check: EditedCheck = { id: t.nextId, was: null, name: '', text: '' };
  return { ...t, checks: [...t.checks, check], nextId: t.nextId + 1 };
}

/** Removes a row of the editor (a column, an index, a key or a check). */
export function removeRow(t: EditedTable, id: number): EditedTable {
  const without = <T extends { id: number }>(rows: readonly T[]) => rows.filter((r) => r.id !== id);
  return {
    ...t,
    columns: without(t.columns),
    indexes: without(t.indexes),
    keys: without(t.keys),
    checks: without(t.checks),
  };
}

/** Moves a column up or down (the order counts when a table is created). */
export function moveColumn(t: EditedTable, id: number, step: 1 | -1): EditedTable {
  const at = t.columns.findIndex((c) => c.id === id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= t.columns.length) return t;
  const columns = [...t.columns];
  [columns[at], columns[to]] = [columns[to], columns[at]];
  return { ...t, columns };
}

/**
 * Changes a column. With another name, the indexes and keys that name it follow – they mean the column,
 * not its name.
 */
export function setColumn(
  t: EditedTable,
  id: number,
  change: Partial<Omit<EditedColumn, 'id' | 'was'>>,
): EditedTable {
  const before = t.columns.find((c) => c.id === id);
  if (!before) return t;
  const columns = t.columns.map((c) => (c.id === id ? { ...c, ...change } : c));
  if (change.name === undefined || change.name === before.name || before.name === '') {
    return { ...t, columns };
  }
  const renamed = (text: string) =>
    joinNames(splitNames(text).map((n) => (n === before.name ? (change.name as string) : n)));
  return {
    ...t,
    columns,
    indexes: t.indexes.map((i) => ({ ...i, columns: renamed(i.columns) })),
    keys: t.keys.map((k) => ({ ...k, columns: renamed(k.columns) })),
  };
}

const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * The table the editor holds, as the backend takes it. What was not touched goes back as it was read
 * (an index of PostgreSQL with its statement), so nothing changes that the user did not change.
 */
export function toTable(t: EditedTable, loaded: TableDef | null): TableDef {
  // a key column is NOT NULL – but one that was read as a key stays as it was read (SQLite says
  // „nullable“ of an `INTEGER PRIMARY KEY`): no change where the user made none
  const readAsKey = (c: EditedColumn) => c.was !== null && (loaded?.pk.includes(c.was) ?? false);
  const columns: ColumnDef[] = t.columns.map((c) => ({
    name: c.name.trim(),
    typeName: c.typeName.trim(),
    nullable: c.pk && !readAsKey(c) ? false : c.nullable,
    default: c.default.trim() === '' ? null : c.default.trim(),
  }));
  // a column that only got another name: its indexes are the same indexes
  const now = new Map(
    t.columns.filter((c) => c.was !== null).map((c) => [c.was as string, c.name.trim()]),
  );
  const moved = (names: readonly string[]) => names.map((n) => now.get(n) ?? n);
  const indexes: IndexDef[] = t.indexes.map((i) => {
    const names = splitNames(i.columns);
    if (
      i.was &&
      i.was.name === i.name.trim() &&
      i.was.unique === i.unique &&
      sameNames(moved(i.was.columns), names)
    ) {
      // untouched – or only following a column that got another name: the same index
      return sameNames(i.was.columns, names) ? i.was : { ...i.was, columns: names };
    }
    return { name: i.name.trim(), unique: i.unique, columns: names, definition: null };
  });
  const keys: KeyDef[] = t.keys.map((k) => {
    const ref = k.refTable.trim();
    const dot = ref.indexOf('.');
    const key: KeyDef = {
      name: k.name.trim(),
      columns: splitNames(k.columns),
      refSchema: dot > 0 ? ref.slice(0, dot) : '',
      refTable: dot > 0 ? ref.slice(dot + 1) : ref,
      refColumns: splitNames(k.refColumns),
    };
    if (
      k.was &&
      k.was.name === key.name &&
      sameNames(moved(k.was.columns), key.columns) &&
      refText(k.was) === ref &&
      sameNames(k.was.refColumns, key.refColumns)
    ) {
      return sameNames(k.was.columns, key.columns) ? k.was : { ...k.was, columns: key.columns };
    }
    return key;
  });
  const checks: CheckDef[] = t.checks.map((c) =>
    c.was && c.was.name === c.name.trim() && c.was.text === c.text
      ? c.was
      : { name: c.name.trim(), text: c.text.trim() },
  );
  const pk = t.columns.filter((c) => c.pk).map((c) => c.name.trim());
  const unchanged =
    loaded !== null &&
    loaded.name === t.name.trim() &&
    sameNames(
      loaded.columns.map((c) => c.name),
      columns.map((c) => c.name),
    );
  return {
    name: t.name.trim(),
    columns,
    // the key in the order it was read, as long as it is the same columns
    pk: loaded && sameNames([...loaded.pk].sort(), [...pk].sort()) ? [...loaded.pk] : pk,
    indexes,
    keys,
    checks,
    comment: loaded?.comment ?? null,
    // SQLite: the statement of the table stands for what it was, not for what it becomes
    definition: unchanged && sameShape(loaded, columns, pk) ? loaded.definition : null,
  };
}

function sameShape(loaded: TableDef, columns: readonly ColumnDef[], pk: readonly string[]) {
  return (
    sameNames([...loaded.pk].sort(), [...pk].sort()) &&
    loaded.columns.every((c, i) => {
      const n = columns[i];
      return (
        n !== undefined &&
        c.typeName === n.typeName &&
        c.nullable === n.nullable &&
        (c.default ?? null) === n.default
      );
    })
  );
}

/** The columns that have another name than when they were read. */
export function renamesOf(t: EditedTable): { from: string; to: string }[] {
  return t.columns
    .filter((c) => c.was !== null && c.was !== c.name.trim() && c.name.trim() !== '')
    .map((c) => ({ from: c.was as string, to: c.name.trim() }));
}

/** What the backend is asked to write. */
export function requestOf(
  schema: string,
  loaded: TableDef | null,
  edited: EditedTable,
): StructRequest {
  return {
    kind: 'change',
    schema,
    before: loaded,
    after: toTable(edited, loaded),
    renames: loaded ? renamesOf(edited) : [],
  };
}

/** What is wrong with a table as it stands in the editor. */
export type Problem =
  | 'noName'
  | 'noColumns'
  | 'columnNoName'
  | 'columnNoType'
  | 'duplicateColumn'
  | 'indexNoColumns'
  | 'partNoName'
  | 'unknownColumn'
  | 'keyIncomplete'
  | 'checkEmpty'
  | 'lineBreak';

/** A control character or a line separator: what would break a statement written on one line. */
function hasLineBreak(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c === 0x85 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** The first thing that keeps the table from being written; `null`: nothing does. */
export function problemOf(t: EditedTable): Problem | null {
  if (t.name.trim() === '') return 'noName';
  if (t.columns.length === 0) return 'noColumns';
  const names = t.columns.map((c) => c.name.trim());
  if (names.some((n) => n === '')) return 'columnNoName';
  if (t.columns.some((c) => c.typeName.trim() === '')) return 'columnNoType';
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return 'duplicateColumn';
  const has = (n: string) => names.includes(n);
  for (const i of t.indexes) {
    const columns = splitNames(i.columns);
    if (i.name.trim() === '') return 'partNoName';
    // an index that is only its statement (an expression) is left as it is
    if (columns.length === 0 && !i.was?.definition) return 'indexNoColumns';
    if (!columns.every(has)) return 'unknownColumn';
  }
  for (const k of t.keys) {
    const columns = splitNames(k.columns);
    const ref = splitNames(k.refColumns);
    if (columns.length === 0 || columns.length !== ref.length || k.refTable.trim() === '') {
      return 'keyIncomplete';
    }
    if (!columns.every(has)) return 'unknownColumn';
  }
  if (t.checks.some((c) => c.text.trim() === '')) return 'checkEmpty';
  if (t.checks.some((c) => c.name.trim() === '')) return 'partNoName';
  const texts = [
    ...t.columns.flatMap((c) => [c.name, c.typeName, c.default]),
    ...t.checks.map((c) => c.text),
    t.name,
  ];
  if (texts.some(hasLineBreak)) return 'lineBreak';
  return null;
}

/** One change of the structure, for the list the user reads before the statements. */
export interface Operation {
  readonly kind:
    | 'createTable'
    | 'renameTable'
    | 'addColumn'
    | 'dropColumn'
    | 'renameColumn'
    | 'changeColumn'
    | 'changeKey'
    | 'addIndex'
    | 'dropIndex'
    | 'changeIndex'
    | 'addForeignKey'
    | 'dropForeignKey'
    | 'changeForeignKey'
    | 'addCheck'
    | 'dropCheck'
    | 'changeCheck';
  /** The thing it is about: a column, an index, the table. */
  readonly name: string;
  /** More: the new name, or what of a column changed. */
  readonly detail: string;
}

/** What changed between the table as it was read and as it stands in the editor. */
export function operations(loaded: TableDef | null, t: EditedTable): Operation[] {
  const after = toTable(t, loaded);
  if (!loaded) return [{ kind: 'createTable', name: after.name, detail: '' }];
  const ops: Operation[] = [];
  if (loaded.name !== after.name) {
    ops.push({ kind: 'renameTable', name: loaded.name, detail: after.name });
  }
  const kept = new Set<string>();
  for (const c of t.columns) {
    const name = c.name.trim();
    if (c.was === null) {
      ops.push({ kind: 'addColumn', name, detail: c.typeName.trim() });
      continue;
    }
    kept.add(c.was);
    const before = loaded.columns.find((x) => x.name === c.was);
    if (c.was !== name) ops.push({ kind: 'renameColumn', name: c.was, detail: name });
    if (!before) continue;
    const now = after.columns.find((x) => x.name === name);
    if (!now) continue;
    const what: string[] = [];
    if (before.typeName !== now.typeName) what.push(`${before.typeName} → ${now.typeName}`);
    if (before.nullable !== now.nullable) what.push(now.nullable ? 'NULL' : 'NOT NULL');
    if ((before.default ?? null) !== now.default) {
      what.push(now.default === null ? 'DROP DEFAULT' : `DEFAULT ${now.default}`);
    }
    if (what.length > 0) ops.push({ kind: 'changeColumn', name, detail: what.join(', ') });
  }
  for (const c of loaded.columns) {
    if (!kept.has(c.name)) ops.push({ kind: 'dropColumn', name: c.name, detail: '' });
  }
  if (!sameNames(loaded.pk, after.pk)) {
    ops.push({ kind: 'changeKey', name: after.name, detail: joinNames(after.pk) });
  }
  // the same thing but for its columns, which follow columns that got another name: no change
  const followed = <D>(was: D, made: D) => {
    const a = was as { columns?: readonly string[] };
    const b = made as { columns?: readonly string[] };
    if (!a.columns || !b.columns) return false;
    const names = new Map(renamesOf(t).map((r) => [r.from, r.to]));
    return (
      JSON.stringify({ ...a, columns: a.columns.map((n) => names.get(n) ?? n) }) ===
      JSON.stringify(b)
    );
  };
  const listed = <T extends { was: unknown; id: number }, D>(
    rows: readonly T[],
    before: readonly D[],
    made: readonly D[],
    kinds: readonly [Operation['kind'], Operation['kind'], Operation['kind']],
    label: (d: D) => string,
    detail: (d: D) => string,
  ) => {
    rows.forEach((row, i) => {
      const now = made[i];
      if (row.was === null) ops.push({ kind: kinds[0], name: label(now), detail: detail(now) });
      else if (row.was !== now && !followed(row.was as D, now)) {
        ops.push({ kind: kinds[2], name: label(row.was as D), detail: detail(now) });
      }
    });
    const still = new Set(rows.map((r) => r.was));
    for (const b of before) {
      if (!still.has(b)) ops.push({ kind: kinds[1], name: label(b), detail: '' });
    }
  };
  listed(
    t.indexes,
    loaded.indexes,
    after.indexes,
    ['addIndex', 'dropIndex', 'changeIndex'],
    (i) => i.name,
    (i) => `${i.unique ? 'UNIQUE ' : ''}(${joinNames(i.columns)})`,
  );
  listed(
    t.keys,
    loaded.keys,
    after.keys,
    ['addForeignKey', 'dropForeignKey', 'changeForeignKey'],
    (k) => k.name || joinNames(k.columns),
    (k) => `(${joinNames(k.columns)}) → ${refText(k)} (${joinNames(k.refColumns)})`,
  );
  listed(
    t.checks,
    loaded.checks,
    after.checks,
    ['addCheck', 'dropCheck', 'changeCheck'],
    (c) => c.name || c.text,
    (c) => c.text,
  );
  return ops;
}

/** The statements of a plan that run, in their order. */
export function statementsOf(plan: StructPlan): string[] {
  return plan.steps.filter((s) => s.sql !== '').map((s) => s.sql);
}

/** Whether a plan holds a step that may lose data. */
export const hasDanger = (plan: StructPlan) => plan.steps.some((s) => s.danger !== null);

/**
 * The plan as a script for the editor: a proposal to read and change. A step that may lose data is
 * written as a comment (`-- DANGER: …`), with its reason – as the schema comparison writes it.
 */
export function scriptOf(plan: StructPlan, header: string): string {
  const lines: string[] = [`-- ${header.replace(/[\r\n]+/g, ' ')}`, ''];
  for (const step of plan.steps) {
    if (step.note) lines.push(`-- ${step.note.replace(/[\r\n]+/g, ' ')}`);
    if (step.sql === '') continue;
    if (step.danger) {
      lines.push(`-- ${step.danger.replace(/[\r\n]+/g, ' ')}:`);
      for (const line of step.sql.split(/\r?\n/)) lines.push(`-- DANGER: ${line}`);
    } else {
      lines.push(step.sql);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** What an object with a source is, as far as saving it differs. */
export type SourceKind = 'view' | 'routine' | 'trigger';

/**
 * The definition of a view or routine as a text to edit and run (task 7): where the dialect can replace
 * an object in one statement, the statement says so (`CREATE OR REPLACE`, `CREATE OR ALTER`); where it
 * cannot, the text stays as it is and `replaces` is `false` (drop it first, by hand).
 */
export function editableSource(kind: DbKind, ddl: string): { text: string; replaces: boolean } {
  const head = /^(\s*(?:--[^\n]*\n\s*)*)CREATE\s+(?!OR\s)/i;
  if (/^\s*(?:--[^\n]*\n\s*)*CREATE\s+OR\s+(REPLACE|ALTER)\b/i.test(ddl)) {
    return { text: ddl, replaces: true };
  }
  const what = /^\s*(?:--[^\n]*\n\s*)*CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(\w+)/i.exec(ddl)?.[1];
  const object = what?.toUpperCase() ?? '';
  switch (kind) {
    case 'postgres':
      if (['VIEW', 'FUNCTION', 'PROCEDURE', 'TRIGGER'].includes(object)) {
        return { text: ddl.replace(head, '$1CREATE OR REPLACE '), replaces: true };
      }
      break;
    case 'mysql':
      // MySQL replaces only views; MariaDB also routines – left to the user there
      if (object === 'VIEW') {
        return { text: ddl.replace(head, '$1CREATE OR REPLACE '), replaces: true };
      }
      break;
    case 'sqlserver':
      if (['VIEW', 'FUNCTION', 'PROCEDURE', 'PROC', 'TRIGGER'].includes(object)) {
        return { text: ddl.replace(head, '$1CREATE OR ALTER '), replaces: true };
      }
      break;
    default:
      break;
  }
  return { text: ddl, replaces: false };
}
