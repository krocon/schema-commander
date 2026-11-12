import { OwnSnippet } from '../../core/settings/settings.models';
import { Dialect } from '../editor/sql-split';

/**
 * Snippets (prompt 024): short prefixes that become text with placeholders (`${1:name}`, `$0` – the syntax
 * of the editor, see `insertSnippet` of `editlicious-editor`). A set comes with the app, per dialect; own
 * ones are settings and win over built-in ones with the same prefix. Pure.
 */
export interface BuiltinSnippet extends OwnSnippet {
  /** The dialects it is for; none = all. */
  readonly dialects?: readonly Dialect[];
}

/** What the editor takes (`el.snippets`). */
export interface EditorSnippet {
  readonly prefix: string;
  readonly body: string;
  readonly description: string;
}

/**
 * Variables the window fills in before the editor sees a snippet: `$TABLE` and `$SCHEMA` are what is under
 * the cursor of the schema tree. (The editor knows `$SELECTION`, `$DATE`, `$TIME` … itself.)
 */
export interface SnippetVars {
  /** As written in SQL (quoted where needed); `null` = nothing chosen. */
  readonly table: string | null;
  readonly schema: string | null;
}

const b = (
  prefix: string,
  description: string,
  body: string,
  dialects?: readonly Dialect[],
): BuiltinSnippet => ({ prefix, description, body, ...(dialects ? { dialects } : {}) });

const NOT_MSSQL: readonly Dialect[] = ['postgres', 'mysql', 'sqlite'];
const ORACLE: readonly Dialect[] = ['oracle'];

export const BUILTIN_SNIPPETS: readonly BuiltinSnippet[] = [
  b('sel', 'SELECT … FROM …', 'SELECT ${1:*}\nFROM ${2:$TABLE}$0'),
  b('selw', 'SELECT … FROM … WHERE …', 'SELECT ${1:*}\nFROM ${2:$TABLE}\nWHERE ${3:condition}$0'),
  b('selc', 'SELECT count(*) FROM …', 'SELECT count(*)\nFROM ${1:$TABLE}$0'),
  b('sell', 'SELECT … LIMIT …', 'SELECT ${1:*}\nFROM ${2:$TABLE}\nLIMIT ${3:100}$0', NOT_MSSQL),
  b(
    'sell',
    'SELECT … FETCH FIRST …',
    'SELECT ${1:*}\nFROM ${2:$TABLE}\nFETCH FIRST ${3:100} ROWS ONLY$0',
    ORACLE,
  ),
  b('blk', 'BEGIN … END; /', 'BEGIN\n  ${1:$SELECTION}\nEND;\n/$0', ORACLE),
  b('selt', 'SELECT TOP … FROM …', 'SELECT TOP ${1:100} ${2:*}\nFROM ${3:$TABLE}$0', ['sqlserver']),
  b(
    'grp',
    'SELECT … GROUP BY …',
    'SELECT ${1:column}, count(*)\nFROM ${2:$TABLE}\nGROUP BY ${1:column}\nORDER BY 2 DESC$0',
  ),
  b(
    'ins',
    'INSERT INTO … VALUES …',
    'INSERT INTO ${1:$TABLE} (${2:columns})\nVALUES (${3:values});$0',
  ),
  b(
    'upd',
    'UPDATE … SET … WHERE …',
    'UPDATE ${1:$TABLE}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};$0',
  ),
  b('del', 'DELETE FROM … WHERE …', 'DELETE FROM ${1:$TABLE}\nWHERE ${2:condition};$0'),
  b('join', 'JOIN … ON …', 'JOIN ${1:table} ${2:t} ON ${2:t}.${3:id} = ${4:other}.${5:id}$0'),
  b(
    'lj',
    'LEFT JOIN … ON …',
    'LEFT JOIN ${1:table} ${2:t} ON ${2:t}.${3:id} = ${4:other}.${5:id}$0',
  ),
  b(
    'cte',
    'WITH … AS (…) SELECT …',
    'WITH ${1:name} AS (\n\t${2:SELECT 1}\n)\nSELECT *\nFROM ${1:name}$0',
  ),
  b(
    'case',
    'CASE WHEN … THEN … ELSE … END',
    'CASE\n\tWHEN ${1:condition} THEN ${2:value}\n\tELSE ${3:other}\nEND$0',
  ),
  b(
    'crt',
    'CREATE TABLE …',
    'CREATE TABLE ${1:name} (\n\t${2:id} ${3:integer} PRIMARY KEY,\n\t${4:column} ${5:text}\n);$0',
  ),
  b('exp', 'EXPLAIN (ANALYZE, BUFFERS) …', 'EXPLAIN (ANALYZE, BUFFERS)\n${1:$SELECTION}$0', [
    'postgres',
  ]),
  b('exp', 'EXPLAIN …', 'EXPLAIN\n${1:$SELECTION}$0', ['mysql']),
  b('exp', 'EXPLAIN QUERY PLAN …', 'EXPLAIN QUERY PLAN\n${1:$SELECTION}$0', ['sqlite']),
  b('tx', 'BEGIN … COMMIT', 'BEGIN;\n${1:$SELECTION}\nCOMMIT;$0', NOT_MSSQL),
  b('tx', 'BEGIN TRANSACTION … COMMIT', 'BEGIN TRANSACTION;\n${1:$SELECTION}\nCOMMIT;$0', [
    'sqlserver',
  ]),
];

/** A value as a literal part of a snippet: `$`, `}` and `\` are signs of the syntax. */
export function escapeForSnippet(value: string): string {
  return value.replace(/[\\$}]/g, (c) => `\\${c}`);
}

/**
 * Fills in `$TABLE`/`${TABLE}` and `$SCHEMA`/`${SCHEMA}`; without a value the word `table` / `schema` stands
 * there (as the placeholder's default). `\$TABLE` stays as it is written.
 */
export function resolveVars(body: string, vars: SnippetVars): string {
  const values: Record<string, string> = {
    TABLE: vars.table ?? 'table',
    SCHEMA: vars.schema ?? 'schema',
  };
  return body.replace(
    /(\\.)|\$\{(TABLE|SCHEMA)\}|\$(TABLE|SCHEMA)\b/g,
    (all, escaped, braced, bare) => (escaped ? all : escapeForSnippet(values[braced ?? bare])),
  );
}

/** The snippets of an editor: the built-in ones of its dialect, own ones on top, variables filled in. */
export function snippetsFor(
  dialect: Dialect,
  own: readonly OwnSnippet[],
  vars: SnippetVars,
): EditorSnippet[] {
  const byPrefix = new Map<string, OwnSnippet>();
  for (const s of BUILTIN_SNIPPETS) {
    if (!s.dialects || s.dialects.includes(dialect)) byPrefix.set(s.prefix, s);
  }
  for (const s of own) byPrefix.set(s.prefix, s);
  return [...byPrefix.values()]
    .sort((x, y) => x.prefix.localeCompare(y.prefix))
    .map((s) => ({
      prefix: s.prefix,
      description: s.description,
      body: resolveVars(s.body, vars),
    }));
}

/** A row of the snippet editor: an own snippet, or a built-in one no own snippet replaces. */
export interface SnippetRow extends OwnSnippet {
  readonly builtin: boolean;
  /** For which databases a built-in one is; `''` = all. */
  readonly where: string;
}

export function snippetRows(own: readonly OwnSnippet[]): SnippetRow[] {
  const taken = new Set(own.map((s) => s.prefix));
  const rows: SnippetRow[] = own.map((s) => ({ ...s, builtin: false, where: '' }));
  for (const s of BUILTIN_SNIPPETS) {
    if (taken.has(s.prefix)) continue;
    rows.push({
      prefix: s.prefix,
      description: s.description,
      body: s.body,
      builtin: true,
      where: (s.dialects ?? []).join(', '),
    });
  }
  return rows.sort((x, y) => x.prefix.localeCompare(y.prefix) || x.where.localeCompare(y.where));
}

export const PREFIX = /^[\p{L}\p{N}_-]{1,32}$/u;

/** What is wrong with a snippet as typed; `null` = nothing. */
export function snippetProblem(
  draft: OwnSnippet,
  own: readonly OwnSnippet[],
  editing: string | null,
): 'prefix' | 'taken' | 'body' | null {
  if (!PREFIX.test(draft.prefix)) return 'prefix';
  if (draft.prefix !== editing && own.some((s) => s.prefix === draft.prefix)) return 'taken';
  if (draft.body.trim() === '') return 'body';
  return null;
}

/** The own snippets with one added or replaced (`editing` = the prefix it had). */
export function withSnippet(
  own: readonly OwnSnippet[],
  draft: OwnSnippet,
  editing: string | null,
): OwnSnippet[] {
  const rest = own.filter((s) => s.prefix !== editing && s.prefix !== draft.prefix);
  return [...rest, draft].sort((x, y) => x.prefix.localeCompare(y.prefix));
}
