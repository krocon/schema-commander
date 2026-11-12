import { offsetAt, placeIn } from '../../core/text/places';

/**
 * Splits a script into statements, by the rules of a dialect (prompt 005). Pure; the cases are in
 * `sql-split.cases.json`. Used for „the statement under the caret“ and for running a selection or a script.
 *
 * - **all**: `;` ends a statement, outside of `'strings'`, `"quoted names"`, `-- line` and block comments.
 * - **postgres**: dollar quoting (`$$ … $$`, `$tag$ … $tag$`), `E'…'` with backslash escapes, nested block
 *   comments.
 * - **mysql**: backticks, `#` line comments, backslash escapes in strings, `DELIMITER` lines (the client
 *   command itself is no statement).
 * - **sqlserver**: `[bracket names]`; a line with only `GO` ends a **batch**. Statements of a batch are found
 *   at `;` for „under the caret“; a script runs batch by batch (`splitBatches`).
 * - **sqlite**: `CREATE TRIGGER … BEGIN … END` keeps its inner `;`.
 * - **duckdb**: dollar quoting, as PostgreSQL.
 * - **clickhouse**: backticks and backslash escapes in strings, as MySQL.
 * - **firebird**: a procedure, function, trigger, package or `EXECUTE BLOCK` keeps the `;` of its body.
 * - **bigquery**: backslash escapes in strings and in backticks, no doubled quotes, strings of three
 *   quotes, `#` comments; a script runs whole (`splitForRun`).
 * - **snowflake**: backslash escapes in strings, `//` comments, `$$ … $$` strings.
 * - **trino**: the common rules – a quote is escaped only by doubling it.
 * - **oracle**: `q'[ … ]'` strings; PL/SQL (`BEGIN`, `DECLARE`, `CREATE … FUNCTION | PROCEDURE | PACKAGE |
 *   TRIGGER | TYPE`) keeps its `;` and ends at a line with only `/` – as in SQL*Plus. That line also ends
 *   any other statement.
 */
export type Dialect =
  | 'postgres'
  | 'mysql'
  | 'sqlserver'
  | 'sqlite'
  | 'oracle'
  | 'duckdb'
  | 'clickhouse'
  | 'trino'
  | 'firebird'
  | 'bigquery'
  | 'snowflake';

export interface Statement {
  /** The statement without its terminator, trimmed. */
  readonly text: string;
  /** Offsets in the script: where the trimmed text starts, and where the terminator stands (exclusive end). */
  readonly start: number;
  readonly end: number;
}

interface Scan {
  readonly script: string;
  readonly dialect: Dialect;
  i: number;
}

const WORD = /[\p{L}\p{N}_$]/u;

/** Skips what is at `s.i` if it is a string, quoted name or comment; returns whether it did. */
function skipToken(s: Scan): boolean {
  const { script, dialect } = s;
  const c = script[s.i];
  const next = script[s.i + 1];
  if (c === "'" && dialect === 'oracle') {
    // q'[ … ]' (also nq'…'): ends at its closing sign followed by a quote, holds quotes as they are
    const prev = script[s.i - 1];
    const before = script[s.i - 2] ?? '';
    const q =
      (prev === 'q' || prev === 'Q') &&
      (!WORD.test(before) ||
        ((before === 'n' || before === 'N') && !WORD.test(script[s.i - 3] ?? '')));
    const open = script[s.i + 1];
    if (q && open !== undefined) {
      const close = { '[': ']', '(': ')', '{': '}', '<': '>' }[open] ?? open;
      const end = script.indexOf(close + "'", s.i + 2);
      s.i = end < 0 ? script.length : end + 2;
      return true;
    }
  }
  if (dialect === 'bigquery' && (c === "'" || c === '"') && next === c && script[s.i + 2] === c) {
    // a string of three quotes: to its three closing ones, a backslash escapes
    let i = s.i + 3;
    while (i < script.length) {
      if (script[i] === '\\') i += 2;
      else if (script[i] === c && script[i + 1] === c && script[i + 2] === c) break;
      else i++;
    }
    s.i = Math.min(i + 3, script.length);
    return true;
  }
  if (c === "'" || c === '"') {
    // PostgreSQL: only E'…' strings know backslash escapes; MySQL: every string does
    const prev = script[s.i - 1];
    const escapes =
      dialect === 'mysql' ||
      dialect === 'clickhouse' ||
      dialect === 'bigquery' ||
      dialect === 'snowflake' ||
      (dialect === 'postgres' &&
        c === "'" &&
        (prev === 'E' || prev === 'e') &&
        !WORD.test(script[s.i - 2] ?? ''));
    skipQuoted(s, c, escapes, dialect !== 'bigquery');
    return true;
  }
  if (c === '`' && dialect !== 'postgres' && dialect !== 'duckdb') {
    // BigQuery: a backslash escapes inside backticks too, and no quote is doubled
    skipQuoted(s, '`', dialect === 'bigquery', dialect !== 'bigquery');
    return true;
  }
  if (c === '[' && (dialect === 'sqlserver' || dialect === 'sqlite')) {
    const close = script.indexOf(']', s.i + 1);
    s.i = close < 0 ? script.length : close + 1;
    return true;
  }
  if (c === '-' && next === '-') {
    skipLine(s);
    return true;
  }
  if (dialect === 'snowflake' && c === '/' && next === '/') {
    skipLine(s);
    return true;
  }
  if (dialect === 'snowflake' && c === '$' && next === '$') {
    // a string between `$$` and `$$`, whatever it holds (the body of a procedure)
    const close = script.indexOf('$$', s.i + 2);
    s.i = close < 0 ? script.length : close + 2;
    return true;
  }
  if (c === '#' && (dialect === 'mysql' || dialect === 'bigquery')) {
    skipLine(s);
    return true;
  }
  if (c === '/' && next === '*') {
    skipBlockComment(s);
    return true;
  }
  // DuckDB knows dollar quotes too
  if (
    c === '$' &&
    (dialect === 'postgres' || dialect === 'duckdb') &&
    !WORD.test(script[s.i - 1] ?? '')
  ) {
    const tag = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(script.slice(s.i, s.i + 80));
    if (tag) {
      const close = script.indexOf(tag[0], s.i + tag[0].length);
      s.i = close < 0 ? script.length : close + tag[0].length;
      return true;
    }
  }
  return false;
}

function skipQuoted(s: Scan, quote: string, escapes: boolean, doubles = true): void {
  const { script } = s;
  let i = s.i + 1;
  while (i < script.length) {
    const c = script[i];
    if (escapes && c === '\\') {
      i += 2;
    } else if (c === quote) {
      // a doubled quote is an escaped quote (not in BigQuery)
      if (doubles && script[i + 1] === quote) i += 2;
      else {
        s.i = i + 1;
        return;
      }
    } else {
      i++;
    }
  }
  s.i = script.length;
}

function skipLine(s: Scan): void {
  const eol = s.script.indexOf('\n', s.i);
  s.i = eol < 0 ? s.script.length : eol + 1;
}

function skipBlockComment(s: Scan): void {
  const { script, dialect } = s;
  let depth = 1;
  let i = s.i + 2;
  while (i < script.length && depth > 0) {
    if (script[i] === '*' && script[i + 1] === '/') {
      depth--;
      i += 2;
    } else if (
      (dialect === 'postgres' || dialect === 'duckdb') &&
      script[i] === '/' &&
      script[i + 1] === '*'
    ) {
      depth++;
      i += 2;
    } else {
      i++;
    }
  }
  s.i = i;
}

function statement(script: string, from: number, to: number): Statement | null {
  const raw = script.slice(from, to);
  const text = raw.trim();
  if (!text) return null;
  const lead = raw.length - raw.trimStart().length;
  return { text, start: from + lead, end: to };
}

/** The word starting at `i` (upper case), or `''`. */
function wordAt(script: string, i: number): string {
  if (WORD.test(script[i - 1] ?? '')) return '';
  const m = /^[A-Za-z_]+/.exec(script.slice(i, i + 16));
  return m ? m[0].toUpperCase() : '';
}

/** Whether the text from `from` to `to` starts a trigger (`CREATE [TEMP] TRIGGER`). */
/** Firebird: a statement with a body in PSQL (from its first `BEGIN` to the `END` that closes it). */
function startsPsql(script: string, from: number, to: number): boolean {
  // comments first: one before the statement may be longer than what is looked at of it
  return /^\s*(?:(?:CREATE(?:\s+OR\s+ALTER)?|ALTER|RECREATE)\s+(?:PROCEDURE|FUNCTION|TRIGGER|PACKAGE)|EXECUTE\s+BLOCK)\b/i.test(
    script
      .slice(from, to)
      .replace(/--[^\n]*\n|\/\*[\s\S]*?\*\//g, ' ')
      .slice(0, 400),
  );
}

/** `SET TERM <new> <old>` at the start of a statement (Firebird's isql); `null` when it is none. */
function setTerm(
  script: string,
  i: number,
  current: string,
): { delimiter: string; end: number } | null {
  const m = /^SET\s+TERM\s+(\S+?)\s*/i.exec(script.slice(i, i + 80));
  if (!m) return null;
  let term = m[1];
  // `SET TERM ^;` – the new one stands right before the old one
  if (term.length > current.length && term.endsWith(current)) {
    term = term.slice(0, -current.length);
    return { delimiter: term, end: i + m[0].trimEnd().length };
  }
  const after = i + m[0].length;
  if (!script.startsWith(current, after)) return null;
  return { delimiter: term, end: after + current.length };
}

function startsTrigger(script: string, from: number, to: number): boolean {
  return /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(
    script.slice(from, Math.min(to, from + 200)).replace(/--[^\n]*\n|\/\*[\s\S]*?\*\//g, ' '),
  );
}

/** `GO` alone on its line (SQL Server), optionally with a count; returns the end of the line or -1. */
function goLine(script: string, i: number): number {
  const lineStart = script.lastIndexOf('\n', i - 1) + 1;
  if (script.slice(lineStart, i).trim() !== '') return -1;
  const m = /^GO(?:[ \t]+\d+)?[ \t]*(?:--[^\n]*)?(?:\r?\n|$)/i.exec(script.slice(i, i + 200));
  return m ? i + m[0].length : -1;
}

/** `/` alone on its line (Oracle: runs what stands above); returns the end of the line or -1. */
function slashLine(script: string, i: number): number {
  const lineStart = script.lastIndexOf('\n', i - 1) + 1;
  if (script.slice(lineStart, i).trim() !== '') return -1;
  const m = /^\/[ \t]*(?:\r?\n|$)/.exec(script.slice(i, i + 200));
  return m ? i + m[0].length : -1;
}

/** Whether a statement that starts at `i` is PL/SQL (Oracle): its `;` belong to it. */
function startsPlsql(script: string, i: number): boolean {
  return /^(?:BEGIN|DECLARE)\b|^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:FUNCTION|PROCEDURE|PACKAGE|TRIGGER|TYPE|LIBRARY)\b/i.test(
    script.slice(i, i + 120),
  );
}

/** `DELIMITER xx` alone on its line (MySQL client command); returns the new delimiter and the line's end. */
function delimiterLine(script: string, i: number): { delimiter: string; end: number } | null {
  const lineStart = script.lastIndexOf('\n', i - 1) + 1;
  if (script.slice(lineStart, i).trim() !== '') return null;
  const m = /^DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i.exec(script.slice(i, i + 200));
  return m ? { delimiter: m[1], end: i + m[0].length } : null;
}

/** The statements of a script. */
export function splitStatements(script: string, dialect: Dialect = 'sqlite'): Statement[] {
  const out: Statement[] = [];
  const s: Scan = { script, dialect, i: 0 };
  let start = 0;
  let delimiter = ';';
  /** Depth of `BEGIN … END` / `CASE … END` inside a trigger (SQLite). */
  let depth = 0;
  let trigger = false;
  /**
   * Firebird: inside a statement with a body, between its `AS` and its first `BEGIN` – where the
   * declarations stand, each with its `;`.
   */
  let declaring = false;
  /** Firebird: inside a sub-routine declared before the body (`DECLARE PROCEDURE … BEGIN … END`). */
  let sub = false;
  /** Firebird: the routine is an external one (`EXTERNAL NAME … AS '…'`): it has no body. */
  let external = false;
  /** Oracle: the statement is PL/SQL (`null` = its first word was not seen yet). */
  let plsql: boolean | null = null;
  const push = (end: number, next: number) => {
    const st = statement(script, start, end);
    if (st) out.push(st);
    start = next;
    declaring = false;
    sub = false;
    external = false;
    depth = 0;
    trigger = false;
    plsql = null;
  };
  while (s.i < script.length) {
    if (skipToken(s)) continue;
    const i = s.i;
    if (dialect === 'sqlserver' && (script[i] === 'G' || script[i] === 'g')) {
      const end = goLine(script, i);
      if (end >= 0) {
        push(i, end);
        s.i = end;
        continue;
      }
    }
    if (dialect === 'mysql' && (script[i] === 'D' || script[i] === 'd')) {
      const line = delimiterLine(script, i);
      if (line) {
        push(i, line.end);
        delimiter = line.delimiter;
        s.i = line.end;
        continue;
      }
    }
    if (dialect === 'oracle') {
      if (script[i] === '/') {
        const end = slashLine(script, i);
        if (end >= 0) {
          push(i, end);
          s.i = end;
          continue;
        }
      }
      if (plsql === null && wordAt(script, i)) plsql = startsPlsql(script, i);
      if (plsql && script[i] === ';') {
        s.i = i + 1;
        continue;
      }
    }
    if (dialect === 'firebird' && script.slice(start, i).trim() === '') {
      // `SET TERM ^ ;` of isql: from here on a statement ends at `^`
      const term = setTerm(script, i, delimiter);
      if (term) {
        start = term.end;
        delimiter = term.delimiter;
        s.i = term.end;
        continue;
      }
    }
    // with a terminator of its own a script says itself where a statement ends
    if (dialect === 'sqlite' || (dialect === 'firebird' && delimiter === ';')) {
      const word = wordAt(script, i);
      if (word) {
        const body =
          dialect === 'sqlite' ? startsTrigger(script, start, i) : startsPsql(script, start, i);
        if (dialect === 'firebird' && body) {
          if (word === 'EXTERNAL' && !trigger && !declaring) external = true;
          if (word === 'AS' && !trigger && !external) declaring = true;
          // a routine declared inside the declarations has a body of its own
          if (
            word === 'DECLARE' &&
            declaring &&
            /^\s+(?:PROCEDURE|FUNCTION)\b/i.test(script.slice(i + 7, i + 40))
          )
            sub = true;
        }
        if (word === 'BEGIN' && body) {
          trigger = true;
          declaring = false;
        }
        if (trigger && (word === 'BEGIN' || word === 'CASE')) depth++;
        else if (trigger && word === 'END') {
          depth--;
          if (depth === 0 && sub) {
            // back among the declarations: the body of the statement is still to come
            sub = false;
            trigger = false;
            declaring = true;
          }
        }
        s.i = i + word.length;
        continue;
      }
    }
    if (script.startsWith(delimiter, i) && depth <= 0 && !declaring) {
      push(i, i + delimiter.length);
      s.i = i + delimiter.length;
      continue;
    }
    s.i = i + 1;
  }
  push(script.length, script.length);
  return out;
}

/**
 * What is sent to the server piece by piece when a script runs: the statements – for SQL Server the batches
 * (`GO`), because a batch is compiled as one and its statements share variables.
 */
export function splitForRun(script: string, dialect: Dialect): Statement[] {
  if (dialect === 'bigquery') {
    // BigQuery runs a text of several statements as one script – with its variables, its blocks
    // (`DECLARE`, `BEGIN … END`, `IF`) and one bill: it is sent whole
    const all = splitStatements(script, dialect);
    if (all.length <= 1) return all;
    const from = all[0].start;
    const to = all[all.length - 1].end;
    return [{ ...all[0], text: script.slice(from, to), start: from, end: to }];
  }
  if (dialect !== 'sqlserver') return splitStatements(script, dialect);
  const out: Statement[] = [];
  const s: Scan = { script, dialect, i: 0 };
  let start = 0;
  const push = (end: number, next: number) => {
    const st = statement(script, start, end);
    // a batch of nothing but separators and comments is none
    if (st && st.text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|;/g, '').trim()) out.push(st);
    start = next;
  };
  while (s.i < script.length) {
    if (skipToken(s)) continue;
    const i = s.i;
    if (script[i] === 'G' || script[i] === 'g') {
      const end = goLine(script, i);
      if (end >= 0) {
        push(i, end);
        s.i = end;
        continue;
      }
    }
    s.i = i + 1;
  }
  push(script.length, script.length);
  return out;
}

/** Offset (UTF-16) of a line and column of the editor (both from 1, the column in characters). */
export function offsetOf(script: string, line: number, ch: number): number {
  return offsetAt(script, { line, ch });
}

/**
 * The statement the caret is in or directly behind (caret after the `;` still means that statement);
 * between two statements the following one, at the very end the last one.
 */
export function statementAt(
  script: string,
  offset: number,
  dialect: Dialect = 'sqlite',
): Statement | null {
  const statements = splitStatements(script, dialect);
  if (!statements.length) return null;
  for (const s of statements) {
    // `end` is the position of the terminator: a caret right behind it still belongs to it
    if (offset <= s.end + 1) return s;
  }
  return statements[statements.length - 1];
}

/**
 * The line and column of the editor (both from 1, the column in characters) of an offset of a text whose
 * first line is line `firstLine`.
 */
export function positionOf(
  text: string,
  offset: number,
  firstLine = 1,
): { line: number; ch: number } {
  return placeIn(text, offset, { line: firstLine, ch: 1 });
}
