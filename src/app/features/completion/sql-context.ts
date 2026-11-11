import { Dialect } from '../editor/sql-split';
import { Token, isName, lex } from './sql-lex';

/**
 * What the completion may offer at the caret (prompt 021): which kind of thing, behind which qualifier, and
 * which tables, aliases and CTEs are in reach – read from the text of the statement alone, tolerant of
 * everything that is not finished yet. A tokenizer and rules (as pgcli does), no parser: a parser of SQL
 * gives up on exactly the texts a completion sees most.
 */
export type Expect =
  /** Nothing: inside a string, a comment, a number, or where a new name is given. */
  | 'none'
  /** The start of a statement. */
  | 'statement'
  | 'table'
  /** A table to join: with the condition from a foreign key first. */
  | 'join'
  | 'column'
  /** The columns of the table an INSERT names, for its column list. */
  | 'insertColumns'
  | 'type'
  | 'routine'
  /** Only keywords fit (behind a table of FROM, behind an expression). */
  | 'keyword';

/** A table (or a derived table, or a CTE) a statement uses. */
export interface TableRef {
  readonly schema: string | null;
  readonly name: string;
  /** How the statement calls it: its alias, else its name. */
  readonly alias: string;
  /** The columns of a derived table or a CTE, as far as its select list names them. */
  readonly columns?: readonly string[];
  /** Named by a CTE or a subquery: no table of the database. */
  readonly local?: boolean;
}

export interface SqlContext {
  readonly expect: Expect;
  /** The word begun left of the caret (may be empty). */
  readonly word: string;
  /** The names in front of a dot before the word: `o.`, `shop.orders.` → `['shop', 'orders']`. */
  readonly qualifier: readonly string[];
  /** The tables in reach, the nearest block first. */
  readonly tables: readonly TableRef[];
  readonly ctes: readonly TableRef[];
  /** The clause the caret is in: `SELECT`, `FROM`, `WHERE`, `GROUP BY` … (`''` = none). */
  readonly clause: string;
  /** What the select list of the block names (aliases and plain columns): for GROUP BY and ORDER BY. */
  readonly selected: readonly string[];
}

const CLAUSES = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'SET',
  'VALUES',
  'RETURNING',
  'WINDOW',
  'INTO',
  'UPDATE',
  'DELETE',
  'INSERT',
  'ON',
  'USING',
  'JOIN',
  'WITH',
]);
const JOIN_WORDS = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'JOIN']);
/** Words that cannot be an alias behind a table. */
const NOT_ALIAS = new Set([
  ...CLAUSES,
  ...JOIN_WORDS,
  'AS',
  'AND',
  'OR',
  'NOT',
  'BY',
  'FOR',
  'LATERAL',
  'APPLY',
  'TABLESAMPLE',
  'PARTITION',
  'DEFAULT',
  'IGNORE',
  'FORCE',
  'USE',
  'STRAIGHT_JOIN',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'IS',
  'IN',
  'LIKE',
  'BETWEEN',
  'EXISTS',
  'ASC',
  'DESC',
  'NULL',
]);
/** Behind these a table is named. */
const TABLE_WORDS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'DESCRIBE', 'TRUNCATE']);
const STATEMENT_START = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'EXPLAIN',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
]);

interface Block {
  /** The tokens of the block, without the parentheses around it. */
  readonly tokens: readonly Token[];
  readonly from: number;
  readonly to: number;
}

/** The index of the `)` that closes the `(` at `open`, or the length when it is not closed. */
function closing(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].text === '(') depth++;
    else if (tokens[i].text === ')' && --depth === 0) return i;
  }
  return tokens.length;
}

/** The blocks around the caret, the innermost first: each parenthesis that holds a query, then the whole. */
function blocksAround(tokens: readonly Token[], caret: number): Block[] {
  const blocks: Block[] = [];
  const opens: number[] = [];
  for (let i = 0; i < tokens.length && tokens[i].start < caret; i++) {
    if (tokens[i].text === '(') opens.push(i);
    else if (tokens[i].text === ')' && tokens[i].end <= caret) opens.pop();
  }
  for (const open of opens.reverse()) {
    const first = tokens[open + 1];
    if (first && (first.value === 'SELECT' || first.value === 'WITH' || first.value === 'VALUES')) {
      const close = closing(tokens, open);
      blocks.push({ tokens: tokens.slice(open + 1, close), from: open + 1, to: close });
    }
  }
  blocks.push({ tokens, from: 0, to: tokens.length });
  return blocks;
}

/** Reads `a`, `a.b` or `a.b.c` at `i`; answers with the names and the index behind them. */
function qualifiedName(
  tokens: readonly Token[],
  i: number,
): { parts: string[]; next: number } | null {
  if (!isName(tokens[i])) return null;
  const parts = [name(tokens[i])];
  let next = i + 1;
  while (tokens[next]?.text === '.' && isName(tokens[next + 1])) {
    parts.push(name(tokens[next + 1]));
    next += 2;
  }
  return { parts, next };
}

/** A name as the statement wrote it (a quoted one without its quotes). */
function name(token: Token): string {
  return token.kind === 'quoted' ? token.value : token.text;
}

/** What a select list names: an alias, or the last name of a plain column; `*` and expressions nothing. */
function selectedNames(tokens: readonly Token[]): string[] {
  const start = tokens.findIndex((t) => t.value === 'SELECT' && t.kind === 'word');
  if (start < 0) return [];
  const names: string[] = [];
  let depth = 0;
  let item: Token[] = [];
  const flush = () => {
    const last = item[item.length - 1];
    const before = item[item.length - 2];
    if (last && isName(last) && !(last.kind === 'word' && NOT_ALIAS.has(last.value))) {
      // `expr AS x`, `expr x`, `t.col`, `col`
      if (item.length === 1 || before?.text === '.' || before?.value === 'AS' || item.length > 1) {
        names.push(name(last));
      }
    }
    item = [];
  };
  for (let i = start + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'comment') continue;
    if (t.text === '(') depth++;
    else if (t.text === ')') depth--;
    if (depth < 0) break;
    if (depth === 0 && t.kind === 'word' && (t.value === 'FROM' || t.value === 'INTO')) break;
    if (depth === 0 && t.text === ',') flush();
    else if (!(depth === 0 && item.length === 0 && (t.value === 'DISTINCT' || t.value === 'ALL'))) {
      item.push(t);
    }
  }
  flush();
  return names;
}

/** The tables a block names behind FROM, JOIN, UPDATE, INTO …, with their aliases. */
function tablesOf(block: readonly Token[]): TableRef[] {
  const refs: TableRef[] = [];
  let depth = 0;
  /** In a list of tables (behind FROM): a comma goes on with the next one. */
  let listing = false;
  for (let i = 0; i < block.length; i++) {
    const t = block[i];
    if (t.kind === 'comment') continue;
    if (t.text === '(') {
      depth++;
      continue;
    }
    if (t.text === ')') {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    const starts = (t.kind === 'word' && TABLE_WORDS.has(t.value)) || (listing && t.text === ',');
    if (t.kind === 'word' && CLAUSES.has(t.value) && !TABLE_WORDS.has(t.value)) listing = false;
    if (!starts) continue;
    listing = t.value === 'FROM' || (listing && t.text === ',') || t.value === 'JOIN';
    let j = i + 1;
    // `INSERT INTO`, `DELETE FROM ONLY`, `JOIN LATERAL`, `TABLE IF EXISTS`
    while (
      block[j]?.kind === 'word' &&
      ['ONLY', 'LATERAL', 'IF', 'EXISTS', 'NOT'].includes(block[j].value)
    ) {
      j++;
    }
    if (block[j]?.text === '(') {
      // a derived table: `( SELECT … ) [AS] alias`
      const close = closing(block, j);
      const inner = block.slice(j + 1, close);
      let k = close + 1;
      if (block[k]?.value === 'AS') k++;
      const alias = block[k];
      if (isName(alias) && !(alias.kind === 'word' && NOT_ALIAS.has(alias.value))) {
        refs.push({
          schema: null,
          name: name(alias),
          alias: name(alias),
          columns: selectedNames(inner),
          local: true,
        });
      }
      i = close;
      continue;
    }
    const q = qualifiedName(block, j);
    if (!q) continue;
    let k = q.next;
    if (block[k]?.value === 'AS' && block[k].kind === 'word') k++;
    const maybe = block[k];
    const alias =
      isName(maybe) && !(maybe.kind === 'word' && NOT_ALIAS.has(maybe.value)) && k > q.next - 1
        ? name(maybe)
        : null;
    const table = q.parts[q.parts.length - 1];
    refs.push({
      schema: q.parts.length > 1 ? q.parts[q.parts.length - 2] : null,
      name: table,
      alias: alias ?? table,
    });
    i = (alias ? k : q.next - 1) > i ? (alias ? k : q.next - 1) : i;
  }
  return refs;
}

/** The CTEs of a statement: `WITH a [(cols)] AS ( … ), b AS ( … )`. */
function ctesOf(tokens: readonly Token[]): TableRef[] {
  const ctes: TableRef[] = [];
  let i = tokens.findIndex((t) => t.kind !== 'comment');
  if (i < 0 || tokens[i].value !== 'WITH') return ctes;
  i++;
  if (tokens[i]?.value === 'RECURSIVE') i++;
  while (isName(tokens[i])) {
    const cte = name(tokens[i]);
    let j = i + 1;
    let columns: string[] | null = null;
    if (tokens[j]?.text === '(') {
      const close = closing(tokens, j);
      columns = tokens
        .slice(j + 1, close)
        .filter(isName)
        .map(name);
      j = close + 1;
    }
    if (tokens[j]?.value !== 'AS') break;
    j++;
    while (tokens[j]?.kind === 'word' && ['NOT', 'MATERIALIZED'].includes(tokens[j].value)) j++;
    if (tokens[j]?.text !== '(') break;
    const close = closing(tokens, j);
    ctes.push({
      schema: null,
      name: cte,
      alias: cte,
      columns: columns ?? selectedNames(tokens.slice(j + 1, close)),
      local: true,
    });
    i = close + 1;
    if (tokens[i]?.text !== ',') break;
    i++;
  }
  return ctes;
}

/**
 * Reads the statement around the caret. `caret` is an offset into `sql` (the text of one statement).
 */
export function analyse(sql: string, caret: number, dialect: Dialect): SqlContext {
  const all = lex(sql, dialect);
  const nothing = (expect: Expect, word = ''): SqlContext => ({
    expect,
    word,
    qualifier: [],
    tables: [],
    ctes: [],
    clause: '',
    selected: [],
  });
  // inside a string or a comment nothing is offered
  const inside = all.find((t) => t.start < caret && (caret < t.end || (t.open && caret <= t.end)));
  if (inside && (inside.kind === 'string' || inside.kind === 'comment')) return nothing('none');
  if (all.some((t) => t.kind === 'number' && t.start < caret && caret <= t.end))
    return nothing('none');
  const tokens = all.filter((t) => t.kind !== 'comment');
  // the word begun: a word or an open quoted name that ends at the caret
  const at = tokens.findIndex((t) => t.start < caret && caret <= t.end && isName(t));
  const begun = at >= 0 && (tokens[at].end === caret || tokens[at].open) ? tokens[at] : null;
  const word = begun
    ? begun.kind === 'quoted'
      ? begun.value
      : begun.text.slice(0, caret - begun.start)
    : '';
  const before = tokens.filter((t) => t.end <= caret && t !== begun);
  // the qualifier: names and dots right before the word
  const qualifier: string[] = [];
  let b = before.length - 1;
  while (before[b]?.text === '.' && isName(before[b - 1])) {
    qualifier.unshift(name(before[b - 1]));
    b -= 2;
  }
  const head = before.slice(0, b + 1);
  const prev = head[head.length - 1];

  const blocks = blocksAround(tokens, caret);
  const ctes = ctesOf(tokens);
  const cteNames = new Set(ctes.map((c) => c.name.toLowerCase()));
  const tables: TableRef[] = [];
  for (const block of blocks) {
    for (const ref of tablesOf(block.tokens)) {
      const cte = ctes.find((c) => c.name.toLowerCase() === ref.name.toLowerCase() && !ref.schema);
      const next: TableRef = cte && !ref.local ? { ...cte, alias: ref.alias } : ref;
      if (!tables.some((t) => t.alias.toLowerCase() === next.alias.toLowerCase()))
        tables.push(next);
    }
  }
  void cteNames;
  const inner = blocks[0];
  const selected = selectedNames(inner.tokens);
  const base = { word, qualifier, tables, ctes, selected };

  // the clause: the last clause word before the caret at the depth of the caret
  const local = head.filter((t) => t.start >= (tokens[inner.from]?.start ?? 0));
  let depth = 0;
  let clause = '';
  let clauseAt = -1;
  for (let i = local.length - 1; i >= 0; i--) {
    const t = local[i];
    if (t.text === ')') depth++;
    else if (t.text === '(') {
      if (depth === 0) {
        // the caret is inside these parentheses: what stands in front decides
        const opener = local[i - 1];
        const beforeOpener = local[i - 2];
        if (
          isName(opener) &&
          (beforeOpener?.value === 'INTO' ||
            local[i - 3]?.value === 'INTO' ||
            local[i - 4]?.value === 'INTO' ||
            local[i - 5]?.value === 'INTO')
        ) {
          clause = 'INSERT COLUMNS';
          clauseAt = i;
          break;
        }
        if (opener?.value === 'VALUES' || opener?.value === 'IN') {
          clause = 'VALUES';
          clauseAt = i;
          break;
        }
        continue;
      }
      depth--;
    } else if (
      depth === 0 &&
      t.kind === 'word' &&
      (CLAUSES.has(t.value) || JOIN_WORDS.has(t.value) || TABLE_WORDS.has(t.value))
    ) {
      clause = t.value;
      clauseAt = i;
      if ((t.value === 'GROUP' || t.value === 'ORDER') && local[i + 1]?.value === 'BY') {
        clause = `${t.value} BY`;
      }
      break;
    }
  }
  const sinceClause = clauseAt < 0 ? local : local.slice(clauseAt + 1);
  const first = tokens.find((t) => t.kind === 'word');
  const context = (expect: Expect): SqlContext => ({ ...base, expect, clause });

  // behind a dot: the columns of what stands in front of it, or the tables of a schema
  if (qualifier.length > 0) {
    // `FROM shop.▮`: what stands in front of the dot is a schema, not a table of the statement
    const naming =
      (TABLE_WORDS.has(clause) || JOIN_WORDS.has(clause)) &&
      (sinceClause.length === 0 || sinceClause[sinceClause.length - 1].text === ',');
    if (naming) {
      const typed = qualifier[qualifier.length - 1].toLowerCase();
      return {
        ...context('table'),
        tables: tables.filter((t) => t.name.toLowerCase() !== typed || t.alias !== t.name),
      };
    }
    return context('column');
  }
  if (!prev) return context('statement');
  // a query begins inside these parentheses: `WITH x AS (▮`
  if (prev.text === '(' && head[head.length - 2]?.value === 'AS' && clause === 'WITH') {
    return context('statement');
  }
  if (prev.kind === 'word' && (prev.value === 'GROUP' || prev.value === 'ORDER'))
    return context('keyword');
  if (
    (prev.value === 'DESC' || prev.value === 'DESCRIBE') &&
    prev.kind === 'word' &&
    head.length === 1
  ) {
    return context('table');
  }
  if (prev.text === ';') return context('statement');
  if (prev.text === '::') return context('type');
  // a new name is given: nothing to offer
  if (prev.kind === 'word' && prev.value === 'AS') {
    const cast = head.some((t, i) => t.value === 'CAST' && head[i + 1]?.text === '(');
    const openCast = cast && clause !== 'WITH' && inParens(head, 'CAST');
    return context(openCast ? 'type' : 'none');
  }
  // data definition: a type behind a new column name
  if (first && (first.value === 'CREATE' || first.value === 'ALTER')) {
    const add = ['ADD', 'COLUMN', 'MODIFY', 'TYPE'].includes(head[head.length - 2]?.value ?? '');
    const inList =
      head.some((t) => t.text === '(') &&
      isName(prev) &&
      [',', '('].includes(head[head.length - 2]?.text ?? '');
    if (prev.value === 'TYPE' && prev.kind === 'word') return context('type');
    if (isName(prev) && (add || inList) && !TABLE_WORDS.has(prev.value)) return context('type');
    if (prev.kind === 'word' && (TABLE_WORDS.has(prev.value) || prev.value === 'ON'))
      return context('table');
    if (first.value === 'CREATE' && !head.some((t) => t.value === 'AS' || t.value === 'ON'))
      return context('keyword');
  }
  if (clause === 'INSERT COLUMNS') return context('insertColumns');
  if (
    prev.kind === 'word' &&
    (prev.value === 'CALL' || prev.value === 'EXEC' || prev.value === 'EXECUTE')
  ) {
    return context('routine');
  }
  // a table is named
  if (JOIN_WORDS.has(clause) && sinceClause.length === 0) {
    return context(clause === 'JOIN' ? 'join' : 'keyword');
  }
  if (TABLE_WORDS.has(clause)) {
    if (sinceClause.length === 0)
      return context(first?.value === 'DROP' || clause !== 'JOIN' ? 'table' : 'join');
    const last = sinceClause[sinceClause.length - 1];
    if (last.text === ',' && clause === 'FROM') return context('table');
    if (['ONLY', 'IF', 'EXISTS', 'LATERAL'].includes(last.value) && last.kind === 'word')
      return context('table');
    if (clause === 'UPDATE' && isName(last)) return context('keyword');
    // behind a table (and its alias): only what goes on with the statement
    return context('keyword');
  }
  if (
    clause === '' &&
    first &&
    STATEMENT_START.has(first.value) &&
    head.length === 1 &&
    first.value !== 'SELECT' &&
    first.value !== 'WITH'
  ) {
    return context('keyword');
  }
  if (clause === 'WITH') return context('none');
  if (clause === 'LIMIT' || clause === 'OFFSET' || clause === 'FETCH') return context('none');
  // behind a finished expression only keywords fit: `WHERE a = 1 ▮`, `SELECT a ▮`
  const operand =
    prev.kind === 'word' ||
    prev.kind === 'quoted' ||
    prev.kind === 'number' ||
    prev.kind === 'string' ||
    prev.text === ')' ||
    prev.text === '*';
  const keywordish =
    prev.kind === 'word' &&
    (NOT_ALIAS.has(prev.value) ||
      CLAUSES.has(prev.value) ||
      ['DISTINCT', 'ALL', 'CASE', 'BY', 'TOP'].includes(prev.value));
  // `SELECT TOP 5 ▮`: the number belongs to TOP
  const top = prev.kind === 'number' && head[head.length - 2]?.value === 'TOP';
  if (operand && !keywordish && !top && !begunAfterOperator(prev)) return context('keyword');
  return context('column');
}

function begunAfterOperator(prev: Token): boolean {
  return prev.kind === 'sign' && prev.text !== ')' && prev.text !== '*';
}

/** Whether the caret is inside the parentheses of a call of `fn` that are still open. */
function inParens(head: readonly Token[], fn: string): boolean {
  let depth = 0;
  for (let i = head.length - 1; i >= 0; i--) {
    if (head[i].text === ')') depth++;
    else if (head[i].text === '(') {
      if (depth === 0) return head[i - 1]?.value === fn;
      depth--;
    }
  }
  return false;
}
